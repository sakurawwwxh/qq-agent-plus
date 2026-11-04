/* eslint-disable max-lines -- 插件页的目录/台账/详情动作集中；批量升级与分页已拆到 plugin-batch.js / plugin-pagination.js */
// 插件页（左侧顶层「插件」）：目录 / 已装 / 手动安装三个面 + 左侧分面栏。
//
// **它不是一个设置分区**（2026-10-16 从「设置 → 插件」搬出来）：
//   · 动作点了就生效（装/卸/启停会起停子进程、重排工具表），没有"保存设置"这一步；
//   · 放进设置里时框架会给每个分区追加一条 sticky 保存条，于是得写一句"不用点下面那个按钮"
//     去解释它 —— 用文案解释布局矛盾，是布局错了的信号。
// 因此这里也**不参与** saveConfig 的键收集（越界检查见 render-test 的"保存分支"用例）。
// 版式照参照（Obsidian 的社区插件目录、VS Code 市场、Raycast 商店，都是暗色、都在应用内）量着做：
//   · **市场就是这一页**：三个面用页签切换（目录 / 已装 / 手动安装），目录是默认面 ——
//     原来"已装台账"压在目录上面，等于让人先看管理再看市场，两样都不像；
//   · **左侧分面栏**（Obsidian 的左边就是它）：范围（全部/已装/有更新）、分类、标签，**都带数量**；
//   · 主区顶部一条工具栏：搜索 + 列表/卡片切换 + 排序（Obsidian 也有列表/卡片两档）；
//   · 卡片按参照**压扁**：图标 + 名字 + 两行说明，说明与名字 15/13.5px（参照是 16/16），
//     不再有一整条页脚；状态与风险标记留在卡面，动作跟在名字后面。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { PLUGIN_PAGE_SIZE, pluginPaginationHtml } from './plugin-pagination.js';
import { upgradeAllPlugins } from './plugin-batch.js';
import { askForConfirmation } from '../core/dom-util.js';
import { iconSvg } from '../core/icons.js';
// README 是作者写的 markdown：与 Release 说明共用同一条"先整体转义、再换少量样式"的通路
//（见 ui/core/format.js 的 formatMinimalMarkdown）—— 不自己再写一份渲染器。
import { formatMinimalMarkdown } from '../core/format.js';
import {
  hasPluginSettings, hydratePluginSettings, savePluginSettings,
  toggleWriteSwitch, decidePendingApproval, clearPluginSecretField, probePlugin,
  startQrLogin, pollQrOnce, setSettingsStatus, stopQrPoll
} from './plugin-settings.js';
import { loadPendingBanner } from './plugin-pending.js';

const CAP_LABELS = {
  tools: '给模型加工具',
  observe: '看群消息',
  schedule: '定时跑任务',
  http: '联网（经宿主）',
  log: '写日志',
  storage: '存自己的状态',
  config: '读自己的配置',
  send: '代机器人发言',
  secrets: '保存凭据（加密）',
  approval: '高风险动作需批准',
  media: '下载与转码媒体',
  quota: '受每日配额限制',
  feed: '提供见闻候选'
};

// 「发布插件」里那三条路的地址：**一处定义**（页面与用例引用同一份，改仓库名不会两边对不上）。
// 只放稳定的仓库地址，不放带锚点的深链 —— 中文锚点在 GitHub 上是转义过的，改一次标题就死。
const PUBLISH = {
  docs: 'https://github.com/sakurawwwxh/qq-agent-plus/blob/main/docs/PLUGINS.md',
  indexRepo: 'https://github.com/sakurawwwxh/qq-agent-plugins',
  examples: 'https://github.com/sakurawwwxh/qq-agent-plus/tree/main/examples/plugins'
};

// 权限的图标：与常量表同一套键，缺了就用中性图标兜底（新增能力时不至于渲染成空白）
const CAP_ICONS = {
  tools: 'sliders', observe: 'chat', schedule: 'clock', http: 'globe',
  log: 'file', storage: 'database', config: 'gear', send: 'zap',
  secrets: 'idcard', approval: 'shield', media: 'play', quota: 'gauge', feed: 'chat'
};

// 权限的"人话解释"：市场页面靠这一栏让使用者判断"要不要信它"。CAP_LABELS 是短词（卡面/台账用），
// CAP_DETAILS 是详情页里逐条展开说清楚"这条权限意味着什么"。
const CAP_DETAILS = {
  tools: '给模型加工具：模型可以在对话里调用它（只读调用，工具返回的内容会进模型上下文）',
  observe: '看群消息：它能读到群里别人发的消息内容（只读，改不了、也拦不住消息）',
  schedule: '定时跑任务：宿主按它声明的时间间隔叫它干活',
  http: '联网（经宿主）：它的网络请求走宿主这条路，内网地址会被拦、有体积与超时上限，且会留日志',
  log: '写日志：它能往控制台日志里写一行（带插件前缀，会脱敏）',
  storage: '存自己的状态：状态由宿主落盘到 plugin-data/<id>/，卸载不删；插件进程自己写不了文件',
  config: '读自己的配置：只能读 plugins.settings 里属于它自己那一段（密钥填那里，别写进代码）',
  send: '代机器人发言：它能以机器人的身份在群里说话（走发送队列：禁言预检、限频、白名单都在）',
  secrets: '保存凭据（加密）：Cookie/Token 用宿主密钥加密落盘；控制台只显示已配置/未配置，不回显明文',
  approval: '高风险动作需批准：点赞/评论这类写操作要先由管理员在插件详情里批准，过期或次数用完自动失效',
  media: '下载与转码媒体：下载与 ffmpeg 合流都由宿主执行（插件进程不能自己跑命令），有体积上限',
  quota: '受每日配额限制：宿主按插件+动作+当天计数，超过上限直接拒绝',
  feed: '提供见闻候选：把条目提交给生活层队列（不能调模型、不能直接发消息；机器人自己决定用不用）'
};

const STATE_LABELS = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
  failed: '已停用（连续崩溃）',
  idle: '待命（按需启动）'
};

// 状态只分四档（跑着 / 待命 / 停了 / 崩了停用），别给每个英文状态各配一色 ——
// 用户读的是"它现在是不是在干活"，不是状态机的枚举名。这四档同时决定左侧状态轨的颜色。
const STATE_TONE = { running: 'running', starting: 'idle', idle: 'idle', stopping: 'off', stopped: 'off', failed: 'failed' };

/** 数字缩写（参照里的下载量都是 241M / 83.5k 这种写法）。 */
function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/**
 * 相对时间（"3 周前"）：参照里的插件详情都是这么写的（Obsidian 的 Last updated 就是 "3 weeks ago"）。
 * 绝对日期留给需要核对的场合（指纹、装的时刻）；"多久没更新"这种判断用相对量更直接。
 */
function relativeTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  // 支持三种形状：YYYY-MM-DD（官方索引用的）、毫秒时间戳（install.installedAt）、
  // 以及第三方索引可能给的完整 ISO 时间。最后一种要单独认出来 —— 直接拼 `T00:00:00`
  // 会拼出一个非法日期，函数就退回原样显示，页面上就会顶着一串 `2026-10-15T10:00:00Z`。
  const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text);
  const when = /^\d+$/.test(text) ? new Date(Number(text)) : new Date(iso ? text : `${text}T00:00:00`);
  if (Number.isNaN(when.getTime())) return text;
  const days = Math.floor((Date.now() - when.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

// ⚠️ 用 Object.hasOwn 而不是 `CAP_LABELS[cap] || cap`：capabilities 是第三方可控的字符串数组，
// 传 "constructor"/"toString" 会命中原型链，界面上显示成 `function Object() { [native code] }`。
const capLabel = (cap) => (Object.hasOwn(CAP_LABELS, cap) ? CAP_LABELS[cap] : String(cap));
const capText = (caps) => (Array.isArray(caps) && caps.length
  ? caps.map(capLabel).join(' · ')
  : '无');

/** 版本比较（只比主干三段，够用且不引依赖）。返回 a>b ? 1 : a<b ? -1 : 0。 */
function compareVersion(a, b) {
  // 剥掉前导 v（索引里的 version 不做 semver 校验，作者写 v1.2.0 很常见；不剥的话 Number('v1')||0 = 0，
  // 于是"索引里有新版本"永远判不出来）
  const parts = (value) => String(value || '').replace(/^[vV]/, '').split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  const left = parts(a); const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 列表筛选状态（搜索词 + 标签 + 排序 + 视图 + 范围）：纯前端，不动索引请求。 */
const pluginFilter = { q: '', tag: '', sort: 'updated', onlyInstalled: false, view: 'grid', range: 'all', page: 1, filterKey: '' };
/** 当前页签（目录 / 已装 / 手动安装） */
let pluginPane = 'catalog';
/** 详情页当前打开的插件 id（空 = 看目录）。市场要有"点进去看清楚再装"这一步。 */
let pluginDetailId = '';
// 从顶部待批条进入详情后，滚到「待你批准」区块（hydrate 完成后才有效）
let pendingJumpTarget = '';
/**
 * 窄屏（≤900px）时左侧筛选栏是否展开。那个宽度下它不能常驻 —— 否则整条筛选
 * （范围 / 分类 / 标签 / 其他）会堆在卡片上方，把列表推到屏幕外（2026-10-17 用户反馈的
 * "标签放在插件上面对吗"就是这个形态）。宽屏不看这个值。
 */
let filtersOpen = false;
let pendingPluginFile = null;   // 用户在「手动安装」里选好、还没提交的那个包
let lastIndex = { plugins: [], skipped: [], sources: [] };
let lastState = null;

/**
 * 装上时的来源记录（没有这份记录 = 手工拷进目录的，如实说）。
 * 机器事实（版本/指纹/时间）单独回传，由调用方排版 —— 第一版把它们用 ` · ` 拼成一串，
 * 读起来是一段难扫的灰字（也正是"模板味"最重的一处）。
 */
const sourceFacts = (install) => {
  if (!install) return { source: '手工放进插件目录的（没有来源记录）', version: '', sha: '', at: '' };
  const when = install.installedAt ? new Date(Number(install.installedAt)) : null;
  return {
    source: install.source || '来源不明',
    version: install.version || '',
    sha: install.sha256 || '',
    at: when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : '',
    publisher: install.publisher || '',
    verified: install.signatureVerified === true
  };
};

/**
 * 按 id 生成一个**确定的色相**（0-359）。
 * 参照（Raycast 商店 / Obsidian 目录 / VS Code 市场）的网格之所以好看，一半功劳是"每个插件
 * 都有自己的彩色 logo" —— 一屏十几格是彩色的一片。索引里的条目既没有 logo 也没有截图，
 * 那就按 id 造一个：同一个插件每次、每台机器都是同一个颜色（简单哈希，不做随机）。
 */
const TILE_HUES = [
  205, // 蓝
  188, // 青
  163, // 青绿
  138, // 绿
  104, // 草绿
  68,  // 黄绿
  38,  // 橙
  14,  // 朱
  340, // 品红
  318, // 紫红
  288, // 紫
  255  // 蓝紫
];

/** 显示名：`name` 是可选字段（索引契约只强制 id/version/sha/地址）—— 缺了就用 id，
 *  否则卡片和详情会顶着一行空白（2026-10-17 用恶意/畸形索引压渲染时抓到）。 */
const itemName = (item) => String(item?.name || item?.id || '?');

function tileHue(seed) {
  const text = String(seed || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 100000;
  }
  // 从**一组挑好的色相**里取，而不是直接 hash%360：直接取模会让几个 id 挤在同一段
  //（实测官方 8 个插件里有 5 个落在紫/橙两段，一屏看着像只有两种颜色）。
  // 这组按色相环均匀铺开，且在深蓝底上都够干净；同一个 id 仍然永远同一个颜色。
  return TILE_HUES[hash % TILE_HUES.length];
}

/**
 * 标识块：索引给了 http(s) 图标地址就用图，否则用**首字母排字**（mono）+ 按 id 生成的色相。
 * ⚠️ 图标地址是**第三方可控的字符串**：只接受 http(s)（服务端归一化也这么挡），并且不用它拼 HTML。
 */
function monoHtml(item, { lg = false, off = false } = {}) {
  const src = String(item?.icon || '');
  const label = String(item?.name || item?.id || '?').trim().slice(0, 1).toUpperCase() || '?';
  const cls = ['plugin-mono', lg ? 'lg' : '', off ? 'is-off' : ''].filter(Boolean).join(' ');
  // 色相挂在元素上（CSS 用 --tile-h 取），同一个 id 永远同一个颜色
  const hue = ` style="--tile-h:${tileHue(item?.id || item?.name)}"`;
  if (/^https?:\/\//i.test(src)) {
    // data-fallback 是"图挂了以后显示什么"：图标地址是第三方给的，404 / 被墙 / 不是图
    // 都很常见，那时浏览器会画一个碎图 —— 比没有图更难看（2026-10-17 压测时 20 个坏地址
    // 里有 7 个直接显示成碎图）。error 监听在 bindPluginsSection 里（error 不冒泡，要捕获阶段）。
    return `<span class="${cls}"${hue}><img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${esc(label)}" /></span>`;
  }
  return `<span class="${cls}"${hue}>${esc(label)}</span>`;
}

/** 作者小头像位（Raycast 那一行是头像 + 数字）：真头像没有，用同名色相的小圆点。 */
function avatarHtml(name) {
  const label = String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
  return `<span class="plugin-avatar" style="--tile-h:${tileHue(name)}" aria-hidden="true">${esc(label)}</span>`;
}

/**
 * 权限：写成一行**图标 + 词**（`title` 挂完整人话）。
 * 第一版每张卡挂三枚灰 chip，八张卡就是二十四枚同款药丸 —— 四件事（分类/标签/权限/状态）
 * 长得一模一样，扫不出重点。词的可读性不比 chip 差，视觉噪音少一个量级。
 */
function capWords(caps, { limit = 0 } = {}) {
  const list = Array.isArray(caps) ? caps.filter(Boolean) : [];
  if (!list.length) return '<span class="lead">没有额外权限</span>';
  const shown = limit > 0 ? list.slice(0, limit) : list;
  const rest = list.length - shown.length;
  return shown.map((cap) => `<span title="${esc(Object.hasOwn(CAP_DETAILS, cap) ? CAP_DETAILS[cap] : '')}">${
    iconSvg(Object.hasOwn(CAP_ICONS, cap) ? CAP_ICONS[cap] : 'chip', { size: 13 })} ${
    esc(capLabel(cap))}</span>`).join('')
    + (rest > 0 ? `<span>等 ${list.length} 项</span>` : '');
}

/** 状态词：一个点 + 一句人话。没跑起来的插件（未启用）也说清楚"为什么没跑"。 */
function stateText(item) {
  if (!item?.installed) return '';
  if (!item.enabled) return '<span class="plugin-state-text off"><i></i>未启用</span>';
  const state = item?.status?.state || '';
  const tone = STATE_TONE[state] || 'off';
  const label = state ? (STATE_LABELS[state] || state) : '待启动';
  return `<span class="plugin-state-text ${tone}"><i></i>${esc(label)}</span>`;
}

/** 状态 → 状态轨的类（挂在行/卡的根节点上，::before 读它上色） */
function stateClass(item) {
  if (item?.revoked) return 'plugin-state-failed';
  if (item?.deprecated) return 'plugin-state-deprecated';
  if (!item?.installed) return 'plugin-state-off';
  if (!item.enabled) return 'plugin-state-off';
  return `plugin-state-${STATE_TONE[item?.status?.state] || 'off'}`;
}

/**
 * 页面正文（由 loadPluginsPage 写进 index.html 里的 #plugins-page）。
 * 骨架在这里、容器在 index.html：容器是**静态节点**，事件委托才只绑一次
 *（与 #asset-page / #usage-page 同一套做法）。
 */
function renderPluginsPage() {
  return `
    <div class="pane-head plugin-page-head">
      <div>
        <h2 id="plugins-head">插件</h2>
        <p class="plugin-claim">
          插件给机器人加上新能力：<b>给模型加工具</b>、<b>看群消息</b>、<b>定时跑任务</b>。
          它们跑在独立进程里，读不到你的配置。 <b>但插件是第三方代码</b> —— 装上等于让作者在这台服务器上跑代码，只装你信得过的。
        </p>
      </div>
      <div class="plugin-master">
        <div class="checkbox-row"><input type="checkbox" id="cfg-plugins-enabled" /><label for="cfg-plugins-enabled">启用插件功能</label></div>
        <div class="hint" id="plugins-isolation"></div>
        <!-- 索引状态：页头一行说清"这份目录从哪来、几条"（任何面都在，包括详情与发布页）。
             页脚还有一段更详细的（带失败原因）—— 两处分工：这里回答"数据可信吗"，
             那里回答"哪个源出问题了"。用户 2026-10-17 反馈"索引都没了"，就是它被挪到列表底部后
             第一眼看不到。 -->
        <div class="hint plugin-source-chip" id="plugins-source-chip"></div>
      </div>
    </div>

    <div class="plugin-pending-banner" id="plugins-pending-banner" hidden></div>

    <div class="plugin-tabs" role="tablist">
      <button type="button" class="plugin-tab is-on" data-plugin-pane="catalog" role="tab" aria-selected="true">目录<span class="plugin-tab-n" id="plugins-tab-catalog"></span></button>
      <button type="button" class="plugin-tab" data-plugin-pane="installed" role="tab" aria-selected="false">已装<span class="plugin-tab-n" id="plugins-tab-installed"></span></button>
      <button type="button" class="plugin-tab" data-plugin-pane="manual" role="tab" aria-selected="false">手动安装</button>
      <!-- 作者入口：做成按钮，而不是第四个页签。页签是"切换视图"，它的样式必须同一；
           而这一条是"换一件完全不同的做事"（读指南 + 去提交），混在页签里会被当成第四个筛选面
           （第一版就是这么做的，用户反馈"不够显眼"）。做成右侧的强调按钮：能点、有色、
           与左边的页签一眼分得开，点了仍然进同一个面。 -->
      <button type="button" class="plugin-publish-cta" data-plugin-pane="publish" role="tab" aria-selected="false">
        ${iconSvg('upload', { size: 13 })}<span>发布插件</span>
      </button>
    </div>

    <div class="plugin-layout" data-plugin-pane-body="catalog">
      <aside class="plugin-facets" id="plugins-facets"></aside>
      <div class="plugin-main">
        <div class="plugin-toolbar">
          <input type="text" id="plugins-search" placeholder="搜名字 / id / 描述 / 标签" aria-label="搜索插件" />
          <!-- 窄屏才有：分面栏在 ≤900px 时收起，靠这个按钮展开。否则整条筛选（范围/分类/标签/其他）
               会堆在卡片上方，把插件列表推到屏幕外（用户："标签放在插件上面对吗"）。 -->
          <button type="button" class="btn btn-small plugin-filter-toggle" data-plugin-filters="1">
            ${iconSvg('filter', { size: 13 })}<span>筛选</span>
          </button>
          <div class="plugin-viewtoggle" role="group" aria-label="视图">
            <button type="button" class="plugin-view is-on" data-plugin-view="grid" title="卡片">${iconSvg('layout', { size: 14 })}</button>
            <button type="button" class="plugin-view" data-plugin-view="list" title="列表">${iconSvg('layers', { size: 14 })}</button>
          </div>
          <select id="plugins-sort" class="plugin-sort" aria-label="插件排序">
            <option value="updated">按最近更新</option>
            <option value="downloads">按下载量</option>
            <option value="name">按名字</option>
          </select>
        </div>
        <!-- 索引拉取失败的告警留在顶部：它说明的是"你看到的整份目录不可信"，
             压到列表底部会被错过。正常状态的来源说明挪到列表尾部（见下面的 .plugin-index-foot）。 -->
        <div class="plugin-index-warn" id="plugins-index-warn" hidden></div>
        <div id="plugins-index" class="plugin-grid"><div class="plugin-empty">正在读取…</div></div>
        <div class="plugin-index-foot" id="plugins-sources"></div>
      </div>
    </div>

    <div data-plugin-pane-body="installed" hidden>
      <div class="plugin-pane-head">
        <span class="plugin-sec-sub" id="plugins-installed-sub"></span>
        <button class="btn btn-small" type="button" id="plugins-upgrade-all">全部更新</button>
      </div>
      <div id="plugins-installed" class="plugin-ledger"><div class="plugin-empty">正在读取…</div></div>
      <div id="plugins-trust" class="plugin-trust"></div>
    </div>

    <div data-plugin-pane-body="manual" hidden>
      <div class="hint" style="margin-bottom:7px">填包地址与它的 <code>sha256</code>（打包脚本会打印）。
        只填地址不行 —— 装的是要执行的代码，至少得有个可核对的内容锚点。</div>
      <div class="gm-row">
        <input type="text" id="plugins-manual-url" placeholder="https://…/my-plugin-1.0.0.tar.gz" aria-label="插件包地址" />
        <input type="text" id="plugins-manual-sha" placeholder="sha256（64 位十六进制）" aria-label="插件包 sha256" />
        <button class="btn btn-small" id="plugins-manual-install" data-plugin-action="install-url">安装</button>
      </div>
      <div class="hint" style="margin:11px 0 5px">或者直接给一个<b>文件</b>（别人发的包、你自己刚打的包）：</div>
      <div class="gm-row" id="plugins-file-drop">
        <input type="file" id="plugins-file" accept=".tar.gz,.tgz,application/gzip,application/x-gzip" aria-label="选择插件包文件" />
        <button class="btn btn-small" id="plugins-file-install" data-plugin-action="install-file" disabled>装这个文件</button>
        <span class="hint" id="plugins-file-name"></span>
      </div>
      <div class="plugin-publish-bridge">
        自己写了一个？<button type="button" class="plugin-linkbtn" data-plugin-pane="publish">看怎么打包、怎么上架 →</button>
      </div>
    </div>

    <!-- 作者向：命令 + 三条分发渠道。措辞按"你已经会写 Node"来写，不解释 JS 基础 →
         这份页面的读者是能看懂 stdin/stdout 的人，其余的人都去装插件了。
         版式是一张卡片里的三段：带图标的抬头（这是哪一页）、三步命令（编号 + 命令行）、
         三条渠道（图标 + 公开程度徽标 + 一句怎么做）、底部的注意条。
         之前是一整段大段文字直接铺在页面背景上，没有边界也没有层次，用户说"太难看了"。 -->
    <div data-plugin-pane-body="publish" hidden>
      <div class="plugin-publish">
        <header class="plugin-publish-hero">
          <span class="plugin-publish-ico">${iconSvg('upload', { size: 20 })}</span>
          <div class="plugin-publish-hero-txt">
            <h3>发布你的插件</h3>
            <p>插件就是一个 <b>Node 进程</b>：从 stdin 读一行行 JSON、按方法名回一行行 JSON。
              <b>零依赖、单文件</b>，三步就能进市场。</p>
          </div>
        </header>

        <div class="plugin-publish-grid">
          <ol class="plugin-steps">
            <li class="plugin-step">
              <span class="plugin-step-n">1</span>
              <div class="plugin-step-body">
                <div class="plugin-step-t">生成骨架</div>
                <pre class="plugin-cmd"><code>node scripts/plugin-create.mjs my-plugin --name "我的插件" --author 你的名字</code></pre>
                <div class="plugin-step-hint">出来一个可以直接跑的目录（右边就是它）。</div>
              </div>
            </li>
            <li class="plugin-step">
              <span class="plugin-step-n">2</span>
              <div class="plugin-step-body">
                <div class="plugin-step-t">真跑一遍：真协议 + 真隔离 + 假 QQ</div>
                <pre class="plugin-cmd"><code>node scripts/plugin-dev.mjs ./my-plugin --call hello --args '{"text":"你好"}'</code></pre>
                <div class="plugin-step-hint">不带参数进交互模式：<code>t</code> 调工具、<code>o</code> 投消息、<code>s</code> 触发周期、<code>l</code> 看日志。
                  它用的就是线上那套 manifest 校验与隔离参数。</div>
              </div>
            </li>
            <li class="plugin-step">
              <span class="plugin-step-n">3</span>
              <div class="plugin-step-body">
                <div class="plugin-step-t">打包 + 自测</div>
                <pre class="plugin-cmd"><code>node scripts/plugin-pack.mjs ./my-plugin --base-url https://github.com/你/my-plugin --tag v0.1.0</code></pre>
                <div class="plugin-step-hint">拿宿主自己的安装器在临时目录里真装一遍，打印的 <code>sha256</code> 就是使用者那边认的那个。
                  <b>自测不过别往外提。</b></div>
              </div>
            </li>
          </ol>

          <!-- 右栏：把"你能得到什么"摆出来，别让三段命令孤零零占满整张卡（宽屏右侧原来一大片空） -->
          <aside class="plugin-publish-side">
            <div class="plugin-publish-side-label">生成的结构</div>
            <pre class="plugin-tree"><code>my-plugin/
├ plugin.json
├ index.mjs
└ README.md</code></pre>
            <div class="plugin-publish-side-label">规矩只有两条</div>
            <ul class="plugin-publish-side-list">
              <li><code>apiVersion: 1</code>，只依赖协议、不 import 宿主内部模块</li>
              <li>零依赖单文件 —— 装的时候不会在用户机器上跑 npm</li>
            </ul>
            <a class="plugin-publish-side-link" href="${PUBLISH.examples}" target="_blank" rel="noopener noreferrer">
              先看 7 个官方示例 →</a>
          </aside>
        </div>

        <div class="plugin-publish-sec">
          <h4>放到别人的目录里</h4>
          <span>按公开程度从高到低，挑一条就行</span>
        </div>
        <div class="plugin-channels">
          <div class="plugin-channel">
            <div class="plugin-channel-head">
              <span class="plugin-channel-ico">${iconSvg('globe', { size: 15 })}</span>
              <b>官方索引</b>
              <span class="plugin-channel-badge">公开</span>
            </div>
            <p>包放 <code>plugins/packages/</code>、挂一个 Release、在 <code>index.json</code> 加一条，然后提 PR
              （模板会问权限、是否签名、源码在哪）。CI 会体检，还每天真下载核对一次 —— 所以别把 Release 删了。</p>
            <a class="plugin-channel-link" href="${PUBLISH.indexRepo}" target="_blank" rel="noopener noreferrer">
              sakurawwwxh/qq-agent-plugins →</a>
          </div>
          <div class="plugin-channel">
            <div class="plugin-channel-head">
              <span class="plugin-channel-ico">${iconSvg('link', { size: 15 })}</span>
              <b>自己的索引</b>
              <span class="plugin-channel-badge">团队内部</span>
            </div>
            <p>把一份同形状的 <code>index.json</code> 挂到任意 HTTPS 地址，在配置里把
              <code>plugins.indexUrls</code> 指向它 —— 私有插件不用公开，装的人照样有一键安装。</p>
          </div>
          <div class="plugin-channel">
            <div class="plugin-channel-head">
              <span class="plugin-channel-ico">${iconSvg('download', { size: 15 })}</span>
              <b>直接给包</b>
              <span class="plugin-channel-badge">不公开</span>
            </div>
            <p>把打好的 <code>.tar.gz</code> 与它的 <code>sha256</code> 一起发给使用者，他在「手动安装」里填进去就行。
              小团队内部用这一条最省事。</p>
          </div>
        </div>

        <p class="plugin-publish-foot">
          <b>装你的插件 = 让你的代码跑在他的服务器上。</b>
          <code>capabilities</code> 写准 —— 这一栏会原样展示给使用者，那是他判断要不要信你的主要依据。
          <a href="${PUBLISH.docs}" target="_blank" rel="noopener noreferrer">协议、字段与能力边界见作者文档 →</a>
        </p>
      </div>
    </div>
    <div class="gm-status plugins-status-bar" id="plugins-status"></div>`;
}

const statusText = () => $('#plugins-status');

let statusTimer = null;
/**
 * 插件页底部状态条：把"正在安装 / 已安装 / 失败"做成跟主题一致的状态胶囊。
 * busy 显示转圈；success/error 用主题色描边与图标；普通提示用灰点。
 * 非 busy 状态会定时收起，避免操作完成后一直挂着一条陈旧提示。
 */
function setStatus(text, { tone = '', busy = false } = {}) {
  const node = statusText();
  if (!node) return;
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  if (!text) {
    node.className = 'gm-status plugins-status-bar';
    node.innerHTML = '';
    return;
  }
  node.className = `gm-status plugins-status-bar${busy ? ' is-busy' : (tone ? ` is-${tone}` : ' is-info')}`;
  const icon = busy
    ? '<span class="loading-spinner" aria-hidden="true"></span>'
    : tone === 'success'
      ? iconSvg('check', { size: 14, cls: 'plugin-status-ico' })
      : tone === 'error'
        ? iconSvg('alert', { size: 14, cls: 'plugin-status-ico' })
        : '<i class="plugin-status-dot" aria-hidden="true"></i>';
  node.innerHTML = `${icon}<span class="plugin-status-text">${esc(text)}</span>`;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  if (!busy) {
    const ms = tone === 'error' ? 15000 : (tone === 'success' ? 10000 : 8000);
    statusTimer = setTimeout(() => {
      if (statusText() !== node) return;
      node.className = 'gm-status plugins-status-bar';
      node.innerHTML = '';
      statusTimer = null;
    }, ms);
  }
}

/** 切页签（目录 / 已装 / 手动安装）：三个面都在 DOM 里，只切显隐 —— 切换不重排、状态不丢。 */
function renderPane() {
  document.querySelectorAll('[data-plugin-pane]').forEach((tab) => {
    const on = tab.dataset.pluginPane === pluginPane;
    tab.classList.toggle('is-on', on);
    // aria-selected 只属于 role=tab 的页签；「手动安装」里那个跳转按钮不是 tab
    if (tab.getAttribute('role') === 'tab') tab.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('[data-plugin-pane-body]').forEach((pane) => {
    const on = pane.dataset.pluginPaneBody === pluginPane;
    if (on) pane.removeAttribute('hidden');
    else pane.setAttribute('hidden', '');
  });
}

/**
 * 页签上的数字：目录有几条可装、已装几个。
 * 参照里这些数就写在分面/页签上（Obsidian 的左侧、HACS 的标签页都带数），它回答"点进去有没有东西"。
 */
function renderTabCounts(state) {
  const plugins = Array.isArray(state?.plugins) ? state.plugins : [];
  const installed = plugins.filter((item) => item.installed).length;
  // 页签上的数是**目录里的条目总数**（含已撤回那条）—— 与分面栏的「全部」同一个口径，
  // 两边不一致会让人以为数字错了（"可装几个"由卡片上的状态自己说）
  const catalogN = (lastIndex?.plugins || []).length;
  const catBox = $('#plugins-tab-catalog');
  if (catBox) catBox.textContent = catalogN ? String(catalogN) : '';
  const instBox = $('#plugins-tab-installed');
  if (instBox) instBox.textContent = installed ? String(installed) : '';
}

/**
 * 左侧分面栏（Obsidian 的版式核心）：范围 / 分类 / 标签 / 其他，**每项带数量**。
 * 数量让人在点之前就知道"这一类里有没有东西"，也把"标签 chip 墙"从横向一行变成了纵向一栏。
 */
function renderFacets(all, installed) {
  const box = $('#plugins-facets');
  if (!box) return;
  const installedIds = new Set((installed?.plugins || []).filter((item) => item.installed).map((item) => item.id));
  const installedVersionOf = new Map((installed?.plugins || []).map((item) => [item.id, item.manifest?.version || item.install?.version || '']));
  const updatable = all.filter((item) => {
    const own = installedVersionOf.get(item.id);
    return own && item.compatible !== false && !item.revoked && compareVersion(item.version, own) > 0;
  }).length;
  const catCounts = new Map();
  const tagCounts = new Map();
  for (const item of all) {
    if (item.category) catCounts.set(item.category, (catCounts.get(item.category) || 0) + 1);
    for (const tag of Array.isArray(item.tags) ? item.tags : []) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
  }
  const group = (label, rows) => (rows.length
    ? `<div class="plugin-facet-group"><div class="plugin-facet-label">${esc(label)}</div>${
      rows.join('')}</div>`
    : '');
  const row = (label, count, { on = false, attr = '', title = '' } = {}) => `<button type="button" class="plugin-facet${
    on ? ' is-on' : ''}" ${attr}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}${
    count === null ? '' : `<span class="plugin-facet-n">${count}</span>`}</button>`;
  const range = [
    row('全部', all.length, { on: pluginFilter.range === 'all', attr: 'data-plugin-range="all"' }),
    row('已装', installedIds.size, { on: pluginFilter.range === 'installed', attr: 'data-plugin-range="installed"' }),
    row('有更新', updatable, { on: pluginFilter.range === 'updatable', attr: 'data-plugin-range="updatable"' })
  ];
  const cats = [...catCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => row(name, n, { on: pluginFilter.category === name, attr: `data-plugin-category="${esc(name)}"` }));
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => row(name, n, { on: pluginFilter.tag === name, attr: `data-plugin-tag="${esc(name)}"` }));
  const other = [
    row('只看已装', null, { on: pluginFilter.onlyInstalled, attr: 'data-plugin-only-installed="1"' }),
    row('隐藏已撤回', null, { on: pluginFilter.hideRevoked, attr: 'data-plugin-hide-revoked="1"' })
  ];
  const clear = (pluginFilter.tag || pluginFilter.q || pluginFilter.onlyInstalled || pluginFilter.range !== 'all' || pluginFilter.category || pluginFilter.hideRevoked)
    ? `<button type="button" class="plugin-facet plugin-facet-clear" data-plugin-clear="1">清除筛选</button>` : '';
  // 四组全在左栏里（照 Obsidian 的分面栏：范围 / 分类 / 标签 / 其他）。
  // 标签原来单独横铺在卡片**上方**（`#plugins-tags`），占了整行、看起来像一条没放好的提示 ——
  // 2026-10-17 用户指出"标签放在插件上面很难看"。参照里没有把标签横着铺在列表上方的：
  // 筛选属于侧栏，列表只放条目本身。
  box.innerHTML = group('范围', range) + group('分类', cats) + group('标签', tags) + group('其他', other) + clear;
}

/**
 * 目录排序：最近更新 / 下载量 / 名字。缺字段的排在后面（不是排在最前，免得"没数据"抢眼）。
 */
function sortMarketList(list, mode) {
  const copy = [...list];
  if (mode === 'downloads') {
    return copy.sort((a, b) => (Number(b.downloads) || 0) - (Number(a.downloads) || 0)
      || String(a.name).localeCompare(String(b.name)));
  }
  if (mode === 'name') return copy.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  // 默认「最近更新」：updatedAt 是 YYYY-MM-DD 文本，直接字符串倒序即可
  return copy.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    || String(a.name).localeCompare(String(b.name)));
}

/** 权限逐条展开（详情页用）：图标 + 短词 + 人话解释。 */
function permissionListHtml(capabilities) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  if (!caps.length) return '<div class="hint">它没有声明任何权限。</div>';
  return `<div class="pd-caps">${caps.map((cap) => `
    <div class="pd-cap">
      <span class="pd-cap-ico">${iconSvg(Object.hasOwn(CAP_ICONS, cap) ? CAP_ICONS[cap] : 'chip', { size: 15 })}</span>
      <div>
        <div class="pd-cap-name">${esc(capLabel(cap))}</div>
        <div class="pd-cap-desc">${esc(Object.hasOwn(CAP_DETAILS, cap) ? CAP_DETAILS[cap] : '这个权限宿主不认识（可能是更新版的宿主加的）')}</div>
      </div>
    </div>`).join('')}</div>`;
}

/**
 * 详情页。版式照参照（VS Code 市场的"色带 Hero + 面包屑 + 正文/侧栏两栏"、Obsidian 的
 * "元信息侧栏 + 相关插件"）：
 *
 *   ← 返回目录 / 插件 / 天气                     ← 面包屑（知道自己在哪）
 *   ┌────┐ 天气 v1.0.0            [安装] [启用]  ← Hero 色带：大图标 + 大名字 + 主动作
 *   │ 天 │ 作者 · ⤓41 次下载 · 4.7KB · 更新于昨天 ← 一行统计（值走 mono）
 *   └────┘ 一句话说明…
 *   ─────────────────────────────────────────
 *   它能做什么（README：真标题层级 + 真链接）    │ 分类 / 标签
 *   它要哪些权限（逐条人话）                     │ 资源（源码/更新日志/完整说明）
 *                                               │ 作者
 *                                               │ 出处与内容指纹（小字，不抢眼）
 *   相关插件…
 */
function renderPluginDetail(item, installed, skipped) {
  const own = (installed?.plugins || []).find((row) => row.id === item.id);
  const installedVersion = own?.manifest?.version || own?.install?.version || '';
  // 与台账同一口径：目录里有更新版**且本机装得下**才给升级按钮（否则点了必然 409）
  const canUpgrade = own?.installed && item.compatible !== false && installedVersion
    && compareVersion(item.version, installedVersion) > 0;
  const actions = [];
  // 撤回与"装没装"是两条线（撤回名单来自索引，装机状态在本机）：**已装 + 被撤回**是真实存在的
  // 组合 —— 那时说"不能安装"是错的，该说的是"它在你机器上，但不会被加载"（与台账同一口径）。
  if (item.revoked && !own?.installed) {
    actions.push('<span class="plugin-state-text failed"><i></i>已被撤回，不能安装</span>');
  } else if (item.revoked) {
    actions.push('<span class="plugin-state-text failed"><i></i>已安装，但已被撤回：不会被加载</span>');
  } else if (!own?.installed) {
    actions.push(item.compatible === false
      ? `<span class="plugin-state-text off"><i></i>本机装不了：${esc(item.reason)}</span>`
      : `<button class="btn btn-primary" data-plugin-action="install" data-plugin-id="${esc(item.id)}">安装</button>`);
  } else if (canUpgrade) {
    actions.push(`<button class="btn btn-primary" data-plugin-action="upgrade" data-plugin-id="${esc(item.id)}">升级到 v${esc(item.version)}</button>`);
  } else if (item.localOnly) {
    actions.push(`<span class="plugin-state-text off"><i></i>已安装 v${esc(installedVersion)}（索引里没有这个插件）</span>`);
  } else if (compareVersion(item.version, installedVersion) < 0) {
    // 本地装的比目录里新：这不是"就是目录版"，说清楚（升级按钮也不该出现）
    actions.push(`<span class="plugin-state-text off"><i></i>已安装 v${esc(installedVersion)}（比目录里的 v${esc(item.version)} 还新）</span>`);
  } else {
    // 同理：状态轨之外不用绿色（"已安装"是事实，不是"活着"）
    actions.push(`<span class="plugin-state-text off"><i></i>已安装（当前就是目录里的版本）</span>`);
  }
  // 被撤回的插件不给启停/回退：启停请求会被接受（写进 enabledIds），但注册表永不加载它 ——
  // 那个按钮等于在说谎。卸载例外（撤回的插件正该被清掉）。
  if (own?.installed && !item.revoked) {
    actions.push(`<button class="btn btn-small" data-plugin-action="${own.enabled ? 'disable' : 'enable'}" data-plugin-id="${esc(item.id)}">${own.enabled ? '停用' : '启用'}</button>`);
    if (Array.isArray(own.backups) && own.backups.length) {
      actions.push(`<button class="btn btn-small" data-plugin-action="rollback" data-plugin-id="${esc(item.id)}">回退到上一版</button>`);
    }
  }
  if (own?.installed && item.revoked) {
    actions.push(`<button class="btn btn-small" data-plugin-action="uninstall" data-plugin-id="${esc(item.id)}">卸载</button>`);
  }
  // 外链一律先过 `^https?://`：这些字符串来自**第三方索引**（plugins.indexUrls 可挂别人的索引），
  // 而 esc() 只挡标签、不挡 scheme —— `javascript:` 会被原样做成可点的 <a>，那是在持有控制台
  // 令牌的页面上执行别人给的脚本。挡不住的宁可不出链接（信息少一点，门必须关）
  const linkOf = (url, label) => (/^https?:\/\//i.test(String(url || '').trim())
    ? `<a href="${esc(String(url).trim())}" target="_blank" rel="noopener noreferrer">${label}</a>` : '');
  const links = [
    linkOf(item.homepage, '源码 / 主页'),
    linkOf(item.changelogUrl, '更新日志'),
    linkOf(item.readmeUrl, '完整说明')
  ].filter(Boolean).join('');
  // Hero 那一行统计：作者（带头像）· 下载量 · 体积 · 更新时间（相对）· 兼容 · 来源。
  // 值走 mono、单位与词走普通字 —— 参照里这一行就是"粗体名字下面一行小字"。
  const stats = [
    item.author ? `<span class="pb-item">${avatarHtml(item.author)}${esc(item.author)}</span>` : '',
    Number(item.downloads) > 0 ? `<span class="pb-item">${iconSvg('download', { size: 13 })}${fmtCount(item.downloads)} 次下载</span>` : '',
    item.size ? `<span class="pb-item">${(item.size / 1024).toFixed(1)} KB</span>` : '',
    item.updatedAt ? `<span class="pb-item">${iconSvg('clock', { size: 13 })}更新于 ${esc(relativeTime(item.updatedAt))}</span>` : '',
    item.minVersion ? `<span class="pb-item">要求宿主 ≥ ${esc(item.minVersion)}</span>` : '',
    `<span class="pb-item">${item.signature ? '已签名（安装时验签）' : '未签名'}</span>`,
    item.source ? `<span class="pb-item">来自 ${esc(item.source)}</span>` : ''
  ].filter(Boolean).join('');
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const homeHost = (() => {
    try { return new URL(String(item.homepage || '')).host.replace(/^www\./, ''); } catch { return ''; }
  })();
  const authorSub = (item.publisher && item.publisher !== item.author)
    ? `发布者 ${item.publisher}`
    : (homeHost || item.source || '来自索引');
  // 被撤回/弃用的原因：贴在 Hero 下面（这是最该被看到的一句）
  const flags = [
    item.revoked ? `<div class="plugin-warn bad">已被撤回：${esc(item.revoked)}</div>` : '',
    item.deprecated ? `<div class="plugin-warn">已弃用：${esc(item.deprecated)}</div>` : ''
  ].filter(Boolean).join('');
  // 相关插件：同分类或同标签的其他条目（最多 3 条）。参照里的详情页底部都有这一节 ——
  // 它是这个页面唯一"逛"的地方，而逛的成本只有一次数组过滤。
  const related = (lastIndex?.plugins || [])
    .filter((other) => other.id !== item.id && !other.revoked)
    .map((other) => ({
      item: other,
      score: (other.category && other.category === item.category ? 2 : 0)
        + (Array.isArray(other.tags) ? other.tags.filter((tag) => tags.includes(tag)).length : 0)
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const readme = String(item.readme || '').trim();
  // 与 icon 同一套：只收 http(s)。服务端归一化已经过滤过，但这是第三方字段，客户端也自己关门
  const screenshots = (Array.isArray(item.screenshots) ? item.screenshots : [])
    .filter((url) => /^https?:\/\//i.test(String(url || '')));
  return `
    <div class="plugin-detail">
      <nav class="plugin-crumbs" aria-label="位置">
        <button type="button" class="plugin-crumb-back" data-plugin-close="1">← 返回目录</button>
        <span class="plugin-crumb-sep">/</span><span class="plugin-crumb">插件</span>
        <span class="plugin-crumb-sep">/</span><span class="plugin-crumb is-cur">${esc(itemName(item))}</span>
      </nav>

      <header class="plugin-hero" style="--tile-h:${tileHue(item.id || item.name)}">
        ${monoHtml(item, { lg: true, off: Boolean(item.revoked) })}
        <div class="plugin-hero-main">
          <div class="plugin-hero-title">
            <h3 class="plugin-detail-name">${esc(itemName(item))}</h3>
            <span class="plugin-ver">v${esc(item.version)}</span>
            ${item.category ? `<span class="plugin-tag">${esc(item.category)}</span>` : ''}
          </div>
          <div class="plugin-hero-stats">${stats}</div>
          <p class="plugin-hero-desc">${esc(item.description)}</p>
        </div>
        <div class="plugin-detail-actions">${actions.join('')}</div>
      </header>
      ${flags ? `<div class="plugin-hero-flags">${flags}</div>` : ''}

      <div class="plugin-detail-grid">
        <div class="plugin-detail-main">
          <div class="pd-block">
            <h4 class="pd-block-title">它能做什么</h4>
            <div class="pd-readme">${readme
    ? formatMinimalMarkdown(readme, { rich: true })
    : esc(item.description || '（这个插件没写说明）')}</div>
            ${screenshots.length ? `<div class="pd-shots">${screenshots.map((url) => `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`).join('')}</div>` : ''}
          </div>
          ${hasPluginSettings(own) ? `<div class="pd-block plugin-settings-block" data-pd-settings="${esc(item.id)}">
            <h4 class="pd-block-title">插件设置</h4>
            <div class="pd-settings-body"><span class="plugin-note">正在读取设置…</span></div>
          </div>` : ''}
          ${String(item.changelog || '').trim() ? `<div class="pd-block">
            <h4 class="pd-block-title">更新日志</h4>
            <div class="pd-readme">${formatMinimalMarkdown(String(item.changelog).trim(), { rich: true })}</div>
          </div>` : ''}
          <div class="pd-block">
            <h4 class="pd-block-title">它要哪些权限</h4>
            ${permissionListHtml(item.capabilities)}
          </div>
          ${(Array.isArray(item.httpDomains) && item.httpDomains.length)
            || (Array.isArray(item.approvals) && item.approvals.length) ? `
          <div class="pd-block">
            <h4 class="pd-block-title">网络与写操作</h4>
            ${Array.isArray(item.httpDomains) && item.httpDomains.length
              ? `<div class="plugin-note">会访问：${item.httpDomains.map(esc).join('、')}</div>` : ''}
            ${Array.isArray(item.approvals) && item.approvals.length
              ? `<div class="plugin-warn">写动作（每次执行需管理员批准具体目标）：${item.approvals
                .map((approval) => esc(approval.label || approval.action)).join('、')}</div>` : ''}
          </div>` : ''}
        </div>

        <aside class="plugin-detail-aside">
          ${tags.length ? `<div class="pd-side">
            <div class="pd-side-label">标签</div>
            <div class="plugin-detail-tags">${tags.map((tag) => `<button type="button" class="plugin-tag is-btn" data-plugin-tag="${esc(tag)}">${esc(tag)}</button>`).join('')}</div>
          </div>` : ''}
          ${links ? `<div class="pd-side">
            <div class="pd-side-label">资源</div>
            <div class="pd-side-links">${links}</div>
          </div>` : ''}
          ${item.author ? `<div class="pd-side">
            <div class="pd-side-label">作者</div>
            <div class="plugin-author">
              <span class="plugin-author-ico" style="--tile-h:${tileHue(item.author)}">${esc(String(item.author || '?').slice(0, 1).toUpperCase())}</span>
              <div>
                <div class="plugin-author-name">${esc(item.author)}</div>
                <div class="plugin-author-sub">${esc(authorSub)}</div>
              </div>
            </div>
          </div>` : ''}
          <div class="pd-side">
            <div class="pd-side-label">出处与指纹</div>
            <div class="plugin-fp"><code>${esc(String(item.sha256 || ''))}</code></div>
            <div class="plugin-note">装之前宿主按这份 sha256 校验，走镜像/加速站也一样 —— 内容被换过会直接拒装。</div>
          </div>
        </aside>
      </div>

      ${related.length ? `
      <div class="plugin-related">
        <h5>相关插件</h5>
        <div class="plugin-related-grid">${related.map(({ item: other }) => `
          <button type="button" class="plugin-related-item" data-plugin-open="${esc(other.id)}">
            ${monoHtml(other, { off: Boolean(other.revoked) })}
            <span style="min-width:0">
              <span class="plugin-related-name">${esc(itemName(other))}</span>
              <span class="plugin-related-desc">${esc(other.description)}</span>
            </span>
          </button>`).join('')}</div>
      </div>` : ''}
      ${skipped && skipped.length ? skippedLine(skipped) : ''}
    </div>`;
}

/** 把用户选的文件读成 base64（走同一条 JSON 请求通道；服务端算 sha256 并回传供核对）。 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/** "另外 N 条被跳过"那一行（缺字段 / id 不合法 / 与靠前的来源重名都算）。 */
function skippedLine(skipped) {
  if (!Array.isArray(skipped) || !skipped.length) return '';
  return `<div class="hint" style="margin-top:8px">另外 ${skipped.length} 条被跳过（缺字段、id 不合法、或与靠前的来源重名）：${
    skipped.slice(0, 5).map((item) => `${esc(item.id || '(没有 id)')} —— ${esc(item.reason)}${item.source ? `（${esc(item.source)}）` : ''}`).join('；')
  }${skipped.length > 5 ? ' …' : ''}</div>`;
}

/**
 * 索引的两种说明，**分开放**（2026-10-17 用户反馈"索引在上面很难受"）：
 *
 *   · `indexWarnHtml` —— 只给"整份目录不可信"的情况（这次没拉到、正在用上次的缓存）。
 *     它说明的是"你现在看到的列表可能是旧的"，所以留在**工具栏下面**，不能压到列表底部。
 *   · `indexFootHtml` —— 正常状态的来源与条数，是"这份数据从哪来"的注脚。原来它是一行
 *     灰色提示顶在卡片上方（看起来像一条没放好的提示），现在挪到列表**尾部**当落款：
 *     需要核对来源的人会往下找，不关心的人不会被它挡在第一眼。
 */
function indexWarnHtml(index) {
  if (!index?.stale) return '';
  const when = relativeTime(String(index.staleAt || '')) || '刚刚';
  return `<span class="plugin-warn">索引这次没拉到（${esc(index.staleReason || '网络原因')}）`
    + `—— 下面是 ${esc(when)}读到的 ${Array.isArray(index.plugins) ? index.plugins.length : 0} 条，`
    + '装之前仍是按索引里的 sha256 校验。</span>';
}

/**
 * 页头那行索引状态：一句话说清"这份目录从哪来、几条"。
 * 与页脚那段不是重复：页头回答"数据可信吗"，页脚回答"哪个源出问题了"。
 */
function indexChipHtml(index) {
  if (index?.loading) return '索引：读取中…';
  if (index?.failed) return `索引：读取失败（显示上次的 ${Array.isArray(index.plugins) ? index.plugins.length : 0} 条）`;
  const sources = Array.isArray(index?.sources) ? index.sources : [];
  if (index?.stale) {
    return `索引：上次的 ${Array.isArray(index.plugins) ? index.plugins.length : 0} 条（这次没拉到）`;
  }
  const ok = sources.filter((item) => item.ok);
  if (!ok.length) return sources.length ? '索引：拉取失败' : '索引：未配置';
  const total = ok.reduce((n, item) => n + (Number(item.count) || 0), 0);
  // 这里是**纯文本**（调用方用 textContent 写入），不能预先转义 —— 否则带查询串的地址会显示成 &amp;
  return `索引：${ok.map((item) => item.name || item.url).join(' + ')} · ${total} 条`;
}

function indexFootHtml(index) {
  if (index?.loading) return '正在读取索引…';
  if (index?.failed) {
    return `索引这次拉取失败（${esc(index.error || '网络原因')}），下面是上次读到的 ${Array.isArray(index.plugins) ? index.plugins.length : 0} 条；装之前仍按索引里的 sha256 校验。`;
  }
  const sources = Array.isArray(index?.sources) ? index.sources : [];
  if (!sources.length) {
    return '没有配置索引来源（<code>plugins.indexUrls</code> / <code>plugins.indexUrl</code> 都是空的），'
      + '所以这里没有可一键安装的列表。「手动安装」仍然可用。';
  }
  return `索引来源：${sources.map((item) => {
    const label = `${esc(item.name || item.url)}${item.ok ? `（${item.count} 条）` : `（拉取失败：${esc(item.error || '未知原因')}）`}`;
    return label;
  }).join(' · ')}`;
}

/**
 * 窄屏筛选面板的展开状态同步到 DOM（宽屏本来就没有这个面板，类名挂着也不影响）。
 * 单独一个函数是因为它要被两处调用：渲染时（页面重建后类名会丢，得重新挂）与点击时。
 */
/**
 * 打开详情。它是这个页面里唯一"钻进去"的导航，所以顺手压一条 history ——
 * 这样浏览器的「后退」（含鼠标侧键、右键菜单里的后退）能回到目录，而不是直接退出插件页。
 */
function openPluginDetail(id) {
  const next = String(id || '');
  if (!next) return;
  // 从详情里点“相关插件”会重建整个详情 DOM（扫码面板也一起消失）；先停掉旧轮询。
  stopQrPoll();
  pluginDetailId = next;
  // 详情只存在于目录面：从「已装」点进来时先切过去，否则点完看不到任何变化（用户反馈的第二个问题）
  if (pluginPane !== 'catalog') { pluginPane = 'catalog'; renderPane(); }
  safeRenderIndex();
  // 从长列表底部点进来时，详情会停在它的中下部（Hero 与「返回目录」都在屏幕外）——
  // 那看起来就像"点了没反应"。打开即回到顶部。
  document.getElementById('plugins-page')?.scrollTo?.({ top: 0 });
  try {
    const history = window.history;
    // 已经在详情里（比如点了「相关插件」）就**替换**当前条目，不再压栈：
    // 否则 A→B 之后按一次「返回目录」只会退回 A 的详情，按钮文案与动作不符。
    if (history?.state && 'pluginDetail' in history.state) history.replaceState({ pluginDetail: next }, '');
    else history?.pushState?.({ pluginDetail: next }, '');
  } catch { /* 没有 history（单测桩）就只渲染 */ }
}

/** 关闭详情。UI 的「返回目录」也走 history.back()，让按钮与浏览器后退是同一个动作。 */
function closePluginDetail() {
  const st = typeof window !== 'undefined' ? window.history?.state : null;
  if (st && 'pluginDetail' in st) {
    // 栈顶是我们压的那条：退一步交给 popstate 收尾 —— 否则按钮和浏览器后退会各退一次。
    // 连点两下（或「返回目录」+ Esc 同时到）时 history.state 还没变，会连退两条 —— 第二条
    // 就退出控制台了。closingDetail 在 popstate 里复位。
    if (closingDetail) return;
    closingDetail = true;
    window.history.back();
    return;
  }
  pluginDetailId = '';
  stopQrPoll();
  safeRenderIndex();
}

/** 不走 history.back() 地清掉详情时，把当前 history 条目上的标记也抹掉 ——
 *  否则「返回目录」会退到上一次打开的那个插件（审查复现：开 A → 点标签 chip → 开 B → 返回，落在 A）。 */
function forgetDetailHistory() {
  try {
    if (typeof window !== 'undefined' && window.history?.state && 'pluginDetail' in window.history.state) {
      window.history.replaceState(null, '');
    }
  } catch { /* 没有 history 就只清界面 */ }
}

function applyFilterPanel() {
  const layout = document.getElementById('plugins-page')?.querySelector('.plugin-layout') || null;
  if (layout) layout.classList.toggle('is-filters-open', filtersOpen);
  const btn = document.getElementById('plugins-page')?.querySelector('[data-plugin-filters]') || null;
  if (btn) {
    btn.classList.toggle('is-on', filtersOpen);
    btn.setAttribute('aria-expanded', filtersOpen ? 'true' : 'false');
  }
}

/** 窄屏下选完一项就把面板收起来 —— 否则结果被面板挡在下面，点了像没反应。 */
function closeFiltersIfNarrow() {
  if (!filtersOpen) return;
  if (!window.matchMedia?.('(max-width: 900px)')?.matches) return;
  filtersOpen = false;
  applyFilterPanel();
}

/**
 * 详情页要的那种"条目"：优先用索引里的（字段最全）；**不在索引里**（手工拷进去的、已下架的）
 * 就用手上的装机记录拼一个 —— 否则在「已装」里点一个目录里没有的插件，点了什么都不会发生。
 * 缺的字段（截图/分类/标签/体积）由详情页优雅降级。
 */
function detailItemFor(id) {
  const hit = (lastIndex?.plugins || []).find((item) => item.id === id);
  if (hit) return hit;
  const own = (lastState?.plugins || []).find((item) => item.id === id);
  if (!own?.installed) return null;
  const m = own.manifest || {};
  const ins = own.install || {};
  return {
    id,
    name: m.name || id,
    version: m.version || ins.version || '',
    description: m.description || '',
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
    sha256: ins.sha256 || '',
    source: ins.source || '本机',
    publisher: ins.publisher || '',
    author: ins.publisher || '',
    revoked: own.revoked || '',
    compatible: true,
    // 标记"这条不在目录里"：动作区那句「当前就是目录里的版本」在没有目录条目时是假话
    localOnly: true
  };
}

function renderIndex(index, installed) {
  const box = $('#plugins-index');
  if (!box) return;
  applyFilterPanel();
  lastIndex = index || { plugins: [], skipped: [], sources: [] };
  lastState = installed;
  const all = Array.isArray(index?.plugins) ? index.plugins : [];
  // 详情页优先：打开了某个插件就只看它（带"返回目录"）
  //
  // ⚠️ 这个判断必须在**用到 skipped 之前**就算出来（原来它写在下面、却在上面被模板引用，
  // 于是 `box.innerHTML = ...` 求值时撞 TDZ：ReferenceError，详情页一个字都渲染不出来，
  // 用户只看到"点了没反应"）。现在 detail 提前算。
  const detail = pluginDetailId ? detailItemFor(pluginDetailId) : null;
  const skipped = Array.isArray(index?.skipped) ? index.skipped : [];
  const srcBox = $('#plugins-sources');
  const warnBox = $('#plugins-index-warn');
  const toolsBox = box.closest('.plugin-main')?.querySelector('.plugin-toolbar');
  const layoutBox = box.closest('.plugin-layout');
  const facetsBox = $('#plugins-facets');
  // 索引侧的两块（顶部告警 / 底部落款）由同一个函数管：详情页里两块都要收起来，
  // 漏一块就会出现"打开插件详情，下面还挂着一行目录来源"的错位。
  const paintIndexNotes = (idx) => {
    // 详情页传 null 表示"收起目录相关的那两块"，但页头的索引状态要留着 ——
    // 它说明的是整页的数据从哪来，与"现在看的是列表还是详情"无关。
    const chipBox = $('#plugins-source-chip');
    if (chipBox) chipBox.textContent = indexChipHtml(idx || lastIndex);
    if (warnBox) {
      const warn = indexWarnHtml(idx);
      if (warn) { warnBox.innerHTML = warn; warnBox.removeAttribute('hidden'); }
      else { warnBox.innerHTML = ''; warnBox.setAttribute('hidden', ''); }
    }
    if (srcBox) srcBox.innerHTML = idx ? indexFootHtml(idx) : '';
  };
  if (detail) {
    // 详情占满主区时，工具栏与分面栏一起收起来：它们此刻点了不会有任何可见变化，
    // 留着反而像"筛选坏了"（分面还会高亮成已选中）
    if (facetsBox) facetsBox.style.display = 'none';
    // ⚠️ **只把分面栏藏起来是不够的**：它是网格的第一个子项，`display:none` 会让它离开网格流，
    // 于是主区落进**第一列**（190px 那一列）—— 详情页只有 190px 宽，里面两栏被算成 122px+0px，
    // 看上去就是"内容全挤一块"（2026-10-16 用户实测）。所以同时把网格切成单列。
    layoutBox?.classList.add('is-detail');
    if (toolsBox) toolsBox.style.display = 'none';
    paintIndexNotes(null);
    box.className = '';                       // 详情不是网格（否则内容宽度会被网格列裁窄）
    box.innerHTML = renderPluginDetail(detail, installed, skipped);
    // 设置面板的数据挂在装机记录里（schema 是 manifest 的一部分）：详情先渲染骨架，再异步填表单。
    const hydrating = Promise.resolve(hydratePluginSettings(detail.id));
    if (pendingJumpTarget === detail.id) {
      const targetId = pendingJumpTarget; pendingJumpTarget = '';
      void hydrating.then(() => { if (pluginDetailId === targetId) document.querySelector('.pd-approval-row.is-pending')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, () => {});
    }
    return;
  }
  if (facetsBox) facetsBox.style.display = '';
  layoutBox?.classList.remove('is-detail');
  if (toolsBox) toolsBox.style.display = '';
  box.className = `plugin-grid${pluginFilter.view === 'list' ? ' is-list' : ''}`;
  paintIndexNotes(index);
  renderFacets(all, installed);

  const installedIds = new Set((installed?.plugins || []).filter((item) => item.installed).map((item) => item.id));
  const installedVersionOf = new Map((installed?.plugins || []).map((item) => [item.id, item.manifest?.version || item.install?.version || '']));
  const needle = pluginFilter.q.trim().toLowerCase();
  const filtered = all.filter((item) => {
    if (pluginFilter.range === 'installed' && !installedIds.has(item.id)) return false;
    if (pluginFilter.range === 'updatable') {
      const own = installedVersionOf.get(item.id);
      if (!own || item.compatible === false || item.revoked || compareVersion(item.version, own) <= 0) return false;
    }
    if (pluginFilter.category && item.category !== pluginFilter.category) return false;
    if (pluginFilter.tag && !(Array.isArray(item.tags) && item.tags.includes(pluginFilter.tag))) return false;
    if (pluginFilter.onlyInstalled && !installedIds.has(item.id)) return false;
    if (pluginFilter.hideRevoked && item.revoked) return false;
    if (!needle) return true;
    return [item.id, item.name, item.description, item.author, ...(item.tags || []), item.category]
      .some((field) => String(field || '').toLowerCase().includes(needle));
  });
  const list = sortMarketList(filtered, pluginFilter.sort);
  const filterKey = JSON.stringify([
    pluginFilter.q, pluginFilter.tag, pluginFilter.sort, pluginFilter.onlyInstalled,
    pluginFilter.view, pluginFilter.range, pluginFilter.category, pluginFilter.hideRevoked
  ]);
  if (pluginFilter.filterKey !== filterKey) {
    pluginFilter.filterKey = filterKey;
    pluginFilter.page = 1;
  }
  const totalPages = Math.max(1, Math.ceil(list.length / PLUGIN_PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(pluginFilter.page) || 1), totalPages);
  pluginFilter.page = page;
  const pageList = list.slice((page - 1) * PLUGIN_PAGE_SIZE, page * PLUGIN_PAGE_SIZE);

  if (!all.length && !skipped.length) {
    box.className = '';
    // 三种"空"要分开说：还在读 / 读取失败 / 真的是空目录 —— 混成一句"没有条目"会让人以为索引没了
    box.innerHTML = index?.loading
      ? '<div class="plugin-empty">正在读取索引…（要拉第三方地址，慢的时候十几秒）</div>'
      : index?.failed
        ? `<div class="plugin-empty">索引这次没拉到：${esc(index.error || '网络原因')}。可以稍后再试，或用「手动安装」。</div>`
        : '<div class="plugin-empty">索引里暂时没有条目。</div>';
    return;
  }
  if (!list.length) {
    // 筛选没结果时也要把"被跳过的条目"列出来：排查"我上架了却不显示"时，那行信息正是要找的
    box.className = '';
    box.innerHTML = `<div class="plugin-empty">没有匹配的条目（索引里共 ${all.length} 条）${
      pluginFilter.q || pluginFilter.tag ? ' —— 换个词或清掉筛选' : ''}。</div>${skippedLine(skipped)}`;
    return;
  }
  const have = installedIds;
  box.innerHTML = pageList.map((item) => {
    const own = (installed?.plugins || []).find((row) => row.id === item.id);
    const isInstalled = have.has(item.id);
    let action = '';
    if (isInstalled) action = '<span class="plugin-state-text off"><i></i>已安装</span>';
    else if (item.revoked) action = '<span class="plugin-state-text failed"><i></i>已撤回</span>';
    else if (item.compatible === false) action = `<span class="plugin-state-text off" title="${esc(item.reason || '')}"><i></i>装不了</span>`;
    else action = `<button class="btn btn-small btn-primary" data-plugin-action="install" data-plugin-id="${esc(item.id)}">安装</button>`;
    // 装过的条目：状态只在这里说一次（"已启用"用 accent、只是装过用灰）
    if (isInstalled && own?.enabled) action = '<span class="plugin-state-text idle"><i></i>已启用</span>';
    const blocked = item.revoked
      ? `<div class="plugin-warn bad">已被撤回：${esc(item.revoked)}</div>`
      : (item.compatible === false
        ? `<div class="plugin-warn">装不了：${esc(item.reason || '与本机不兼容')}</div>`
        : '');
    // 卡片上只留**该让人停一下**的那两项权限（能看群消息 / 能代机器人发言）——
    // 其余（工具、联网、配置）是常态，退到详情页逐条说。这两项一旦不知道就晚了，所以破例留在卡片上。
    const risky = (Array.isArray(item.capabilities) ? item.capabilities : [])
      .filter((cap) => cap === 'observe' || cap === 'send');
    const marks = [
      item.category ? `<span class="plugin-tag">${esc(item.category)}</span>` : '',
      item.deprecated ? '<span class="plugin-tag is-warn">已弃用</span>' : '',
      // 能看群消息 = 暖色提醒；能代机器人发言 = 红（它以机器人的身份说话，这一条最该被看见）
      risky.map((cap) => `<span class="plugin-tag ${cap === 'send' ? 'is-danger' : 'is-warn'}" title="${
        esc(CAP_DETAILS[cap])}">${cap === 'observe' ? '能看群消息' : '能代发言'}</span>`).join('')
    ].filter(Boolean).join('');
    // data-plugin-open 挂在**整张卡**上：点说明、点图标都能进详情（委托里先判动作按钮，
    // 所以卡内的「安装」不会被这条抢先吃掉）
    return `
      <article class="plugin-card ${stateClass(item)}" data-plugin-open="${esc(item.id)}" tabindex="0" role="button" aria-label="查看 ${esc(itemName(item))} 详情">
        <div class="plugin-card-head">
          ${monoHtml(item, { off: Boolean(item.revoked) })}
          <div class="plugin-card-title">
            <span class="plugin-name">${esc(itemName(item))}</span>
            ${marks}
          </div>
          <span class="plugin-card-action">${action}</span>
        </div>
        <div class="plugin-card-desc">${esc(item.description)}</div>
        ${blocked}
        <div class="plugin-card-foot">
          ${item.author ? `<span class="pb-item">${avatarHtml(item.author)}${esc(item.author)}</span>` : ''}
          ${Number(item.downloads) > 0 ? `<span class="pb-item">${iconSvg('download', { size: 13 })}${fmtCount(item.downloads)}</span>` : ''}
          ${item.updatedAt ? `<span class="pb-item">${iconSvg('clock', { size: 13 })}${esc(relativeTime(item.updatedAt))}</span>` : ''}
        </div>
      </article>`;
  }).join('') + pluginPaginationHtml(page, totalPages, list.length) + skippedLine(skipped);
}

/**
 * 信任与撤回（只读）：发布者公钥与撤回名单分散在配置里，出问题时最容易被忘掉。
 * 这里只展示，不提供编辑 —— 公钥是安全边界，改它应该走配置文件并留下审计，而不是随手点。
 */
function renderTrust(state) {
  const box = $('#plugins-trust');
  if (!box) return;
  const publishers = state?.publishers && typeof state.publishers === 'object'
    ? Object.entries(state.publishers).filter(([name]) => name)
    : [];
  const revoked = Array.isArray(state?.revoked) ? state.revoked.filter(Boolean) : [];
  if (!publishers.length && !revoked.length) {
    box.innerHTML = '<div class="hint">还没有登记发布者公钥，也没有撤回名单。</div>';
    return;
  }
  const keyText = (value) => {
    const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return raw.length > 32 ? `${raw.slice(0, 24)}…` : raw;
  };
  box.innerHTML = `
    <h3>信任与撤回</h3>
    <div class="hint">只读视图：发布者公钥用于安装时验签，撤回名单命中后插件不会加载。修改请编辑配置 <code>plugins.publishers</code> / <code>plugins.revoked</code>。</div>
    ${publishers.length ? `<div class="plugin-trust-title">已登记发布者（${publishers.length}）</div>
      <ul class="plugin-trust-list">${publishers.map(([name, value]) => `<li><b>${esc(name)}</b> <code>${esc(keyText(value))}</code></li>`).join('')}</ul>` : ''}
    ${revoked.length ? `<div class="plugin-trust-title">撤回名单（${revoked.length}）</div>
      <ul class="plugin-trust-list">${revoked.map((rule) => `<li><code>${esc(String(rule))}</code></li>`).join('')}</ul>` : ''}
  `;
}

/** 已装：台账（发丝线分行，每条一行；左侧状态轨由状态类给色）。 */
function renderInstalled(state) {
  const box = $('#plugins-installed');
  if (!box) return;
  const sub = $('#plugins-installed-sub');
  if (!state || !Array.isArray(state.plugins) || !state.plugins.length) {
    if (sub) sub.textContent = '';
    box.innerHTML = '<div class="plugin-empty">还没装任何插件。目录里点「安装」就能装。</div>';
    return;
  }
  const idleMinutes = Math.max(0, Number(state.idleMinutes) || 0);
  // 索引里有没有更新的版本：有就提示升级（升级走同一个安装接口 —— 换入 + 备份 + 回滚都是现成的）
  const indexById = new Map((lastIndex.plugins || []).map((entry) => [entry.id, entry]));
  const enabledCount = state.plugins.filter((item) => item.installed && item.enabled).length;
  if (sub) sub.textContent = `${state.plugins.length} 个 · ${enabledCount} 个在跑`;

  box.innerHTML = state.plugins.map((item) => {
    const installed = item.installed === true;
    const indexEntry = indexById.get(item.id);
    const installedVersion = item.manifest?.version || item.install?.version || '';
    const upgrade = installed && !item.revoked && indexEntry && indexEntry.compatible !== false && installedVersion
      && compareVersion(indexEntry.version, installedVersion) > 0 ? indexEntry.version : '';
    const facts = sourceFacts(item.install);
    const running = item.status?.state === 'running';
    const idleText = idleMinutes > 0 ? `空闲 ${idleMinutes} 分钟停` : '空闲不停';
    const runtime = [];
    if (item.lazy) runtime.push(`按需启动 · ${idleText}`);
    if (running && item.status?.rssKb) runtime.push(`内存 ${(item.status.rssKb / 1024).toFixed(0)}MB`);
    if (running) runtime.push(item.status?.netIsolated ? '网络已隔离' : '网络未隔离');
    // 动作按"下一步最可能做什么"排：装了没跑 → 启用；跑着且有新版 → 升级；其余退成文字按钮。
    // 第一版一行四个方块按钮（连卸载都长一样）主次不分；把"启用"挤掉更是功能缺失 ——
    // 装了没启用而目录里又有新版时，上一版只给「升级到 vX」，想先跑起来只能被迫升级。
    // 受撤回保护的是"启停/回退/升级"（撤回的插件不会加载，那些按钮等于在说谎），
    // 但**卸载必须给** —— 撤回的插件正该被清掉，不给入口就只剩"上服务器手删目录"这条路。
    const acts = [];
    if (installed && !item.revoked) {
      if (!item.enabled) acts.push(['primary', 'enable', '启用']);
      if (upgrade) acts.push([item.enabled ? 'primary' : 'quiet', 'upgrade', `升级到 v${upgrade}`]);
      // 停用是"反悔键"不是下一步：跑着又没有新版时，这一行**不该有实心按钮**
      //（主色用来指路，没有路要指的时候就留白）
      if (item.enabled) acts.push(['plain', 'disable', '停用']);
      if (Array.isArray(item.backups) && item.backups.length) acts.push(['quiet', 'rollback', '回退上一版']);
      acts.push(['quiet', 'reload', '重载']);
    } else if (upgrade) {
      acts.push(['primary', 'upgrade', `升级到 v${upgrade}`]);
    }
    if (installed) acts.push(['danger', 'uninstall', '卸载']);
    const actionHtml = acts.map(([tone, action, label]) => {
      // label 里含索引来的版本号（`升级到 v${upgrade}`）：索引是第三方内容源，必须转义后再拼
      const text = esc(label);
      if (tone === 'quiet' || tone === 'danger') {
        return `<button class="plugin-act${tone === 'danger' ? ' is-danger' : ''}" data-plugin-action="${esc(action)}" data-plugin-id="${esc(item.id)}">${text}</button>`;
      }
      if (tone === 'plain') {
        return `<button class="btn btn-small" data-plugin-action="${esc(action)}" data-plugin-id="${esc(item.id)}">${text}</button>`;
      }
      return `<button class="btn btn-small btn-primary" data-plugin-action="${esc(action)}" data-plugin-id="${esc(item.id)}">${text}</button>`;
    }).join('');
    const notes = [];
    if (upgrade) notes.push(`<div class="plugin-note">目录里有新版本 v${esc(upgrade)}（装着 v${esc(installedVersion)}）</div>`);
    if (item.revoked) notes.push(`<div class="plugin-warn bad">该插件在撤回名单里（${esc(item.revoked)}），不会加载、也不给模型用</div>`);
    if (item.status?.unconfined) {
      notes.push('<div class="plugin-warn">以「未隔离」方式运行：这个插件进程读得到 config.json（本机没有权限模型，且配置里关掉了 requireIsolation）</div>');
    }
    const stats = item.status?.stats || {};
    const runtimeBits = [];
    if (Number(item.status?.restarts) > 0) runtimeBits.push(`重启 ${item.status.restarts} 次`);
    if (Number(stats.crashes) > 0) runtimeBits.push(`崩溃 ${stats.crashes} 次`);
    if (Number(stats.timeouts) > 0) runtimeBits.push(`超时 ${stats.timeouts} 次`);
    if (Number(stats.rateLimited) > 0) runtimeBits.push(`限流 ${stats.rateLimited} 次`);
    if (Number(stats.memoryKills) > 0) runtimeBits.push(`内存重启 ${stats.memoryKills} 次`);
    if (runtimeBits.length) notes.push(`<div class="plugin-note">运行统计：${esc(runtimeBits.join(' · '))}</div>`);
    if (item.status?.state === 'failed') {
      const crashDisabled = Number(stats.crashes) >= 3;
      notes.push(`<div class="plugin-warn bad">${crashDisabled ? '连续崩溃已自动停用' : '启动失败'}${
        item.status.lastError ? `：${esc(item.status.lastError)}` : ''}</div>`);
    } else if (item.status?.lastError) {
      notes.push(`<div class="plugin-warn bad">最近错误：${esc(item.status.lastError)}</div>`);
    }
    // 目录存在但 manifest 读不出来的"发现项"：它不是已装，也不该能点进详情 —— 把原因摆出来
    if (!installed && item.error) notes.push(`<div class="plugin-warn bad">这个目录加载不了：${esc(item.error)}</div>`);
    const caps = Array.isArray(item.manifest?.capabilities) ? item.manifest.capabilities : [];
    const tools = Array.isArray(item.manifest?.tools) && item.manifest.tools.length ? `工具 ${item.manifest.tools.length} 个` : '';
    return `
      <div class="plugin-row ${stateClass(item)}"${installed ? ` data-plugin-open="${esc(item.id)}" tabindex="0" role="button" aria-label="查看 ${esc(item.manifest?.name || item.id)} 详情"` : ''}>
        ${monoHtml({ icon: indexEntry?.icon, name: item.manifest?.name || item.id, id: item.id }, { off: !installed })}
        <div class="plugin-row-main">
          <div class="plugin-row-top">
            <span class="plugin-name">${esc(item.manifest?.name || item.id)}</span>
            <span class="plugin-ver">v${esc(installedVersion || '—')}</span>
            ${stateText(item)}
            ${tools ? `<span class="plugin-fact">${tools}</span>` : ''}
          </div>
          <div class="plugin-caps-inline"><span class="lead">权限</span>${capWords(caps)}</div>
          <div class="plugin-fact">来源：${esc(facts.source)}${
  facts.sha ? ` · sha256 ${esc(facts.sha.slice(0, 12))}…` : ''}${facts.at ? ` · ${esc(facts.at)}` : ''}${
  facts.publisher ? ` · 发布者 ${esc(facts.publisher)}${facts.verified ? '（签名已验证）' : '（未验证）'}` : ''}</div>
          ${runtime.length ? `<div class="plugin-note">${esc(runtime.join(' · '))}</div>` : ''}
          ${notes.join('')}
        </div>
        <div class="plugin-row-actions">${actionHtml}</div>
      </div>`;
  }).join('');
}

/**
 * 渲染插件页并兜住异常。打开详情/分面/排序/搜索都是**同一条"点了没反应"**的路径：
 * 事件委托里的异常会成为未处理的 rejection（浏览器只留一行 console 错误），
 * 用户看到的是按钮失灵。渲染出错就说出来。
 */
function safeRenderIndex() {
  try { renderIndex(lastIndex, lastState); } catch (error) { setStatus(`刷新插件页失败：${error?.message || error}`, { tone: 'error' }); }
}

async function refreshPlugins() {
  try {
    const state = await api('/api/plugins');
    const enabledBox = $('#cfg-plugins-enabled');
    if (enabledBox) enabledBox.checked = state?.enabled === true;
    const iso = $('#plugins-isolation');
    if (iso) {
      const isolation = state?.isolation || {};
      const net = isolation.net
        ? '网络也是断的（插件进程在无网络的命名空间里，要联网只能走宿主那条有审计的路）。'
        : '但它拦不住网络（Node 权限模型不管网络；本机也没有可用的网络命名空间），所以它看到的内容可能被外发。';
      if (isolation.supported) {
        // 状态带已经给了"可用/不可用"的结论，这句只补**它说不清的那部分**（拦不住网络意味着什么）
        iso.textContent = `插件进程读不到配置文件、起不了子进程、写不了文件；${net}`;
      } else if (state?.requireIsolation === false) {
        // 配置里明确关掉了 requireIsolation：插件**是会被加载的**（每行也会标"未隔离运行"），
        // 这里再说"不会被加载"就是自相矛盾 —— 用户正是那个明确关掉的人
        iso.textContent = '⚠️ 本机 Node 没有权限隔离，而配置里关掉了 plugins.requireIsolation：插件会以「未隔离」方式运行，读得到 config.json（风险自负，下面每行也会标出来）。';
      } else {
        iso.textContent = '⚠️ 本机 Node 不支持权限隔离 —— 插件不会被加载（换 Node，或明确关掉 plugins.requireIsolation，那时它们会以未隔离方式运行）。';
      }
    }
    // **先渲染"不依赖索引"的那一半**：已装台账、页签数字、面的显隐只用到 /api/plugins；
    // 索引要走第三方的 GitHub raw，慢的时候十几秒（2026-10-16 生产实测首屏等了 20 秒）。
    // 把索引挡在前面等于让整页陪它等 —— 拆开后台账立刻可见，目录随后自己填上。
    // ⚠️ 别在这里清成空表：索引要走第三方（慢的时候十几秒），清空会让页头/页脚在这段时间里
    // 说「索引未配置」「没有配置索引来源」—— 全是假话（用户就反馈过「索引都没了」）。
    // 保留上一次的列表 + 打上 loading 标记：界面显示「读取中」，详情也不会降级成 local-only。
    lastIndex = { ...lastIndex, loading: true };
    lastState = state;
    renderTabCounts(state);
    renderPane();
    renderInstalled(state);
    renderTrust(state);
    renderIndex(lastIndex, state);

    let index = { plugins: [], skipped: [], sources: [] };
    try {
      index = await api('/api/plugins/index');
    } catch (error) {
      setStatus(`索引拉取失败：${error?.message || error}`, { tone: 'error' });
      // 拉不到就沿用上一次成功的列表（如果有），并让页签/页脚说"读取失败"而不是"未配置"
      index = { ...lastIndex, loading: false, failed: true, error: String(error?.message || error) };
    }
    // 先记下索引再渲染：那一行里的"索引里有更新版本 → 升级"提示要看索引，
    // 反过来写的话提示要等到下一次渲染才出现（要用例点出来的那种"点了没反应"）
    lastIndex = index;
    renderTabCounts(state);
    renderInstalled(state);       // 台账里的"有更新"提示要等索引到了才出得准
    renderTrust(state);
    renderIndex(index, state);
    return state;
  } catch (error) {
    setStatus(`读取插件状态失败：${error?.message || error}`, { tone: 'error' });
    renderInstalled(null);
    renderTrust(null);
    return null;
  }
}

async function post(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}

let delegationBound = false;
let popstateBound = false;
/** 正在等 popstate 收尾（防止连点「返回目录」把两层历史一起退掉） */
let closingDetail = false;

/** 绑定这一页的控件（渲染后调用一次；按钮走事件委托，刷新表格不用重绑）。 */
function bindPluginsSection() {
  const upgradeAll = $('#plugins-upgrade-all');
  if (upgradeAll && upgradeAll.dataset.bound !== '1') {
    upgradeAll.dataset.bound = '1';
    upgradeAll.addEventListener('click', () => upgradeAllPlugins({
      post, setStatus, refreshPlugins, askForConfirmation
    }));
  }
  // 总开关那个复选框每次渲染都重建 → 每次都要绑（旧节点连同监听一起被丢弃）
  $('#cfg-plugins-enabled')?.addEventListener('change', async (event) => {
    const enabled = event.currentTarget.checked;
    try {
      await post('/api/plugins/master', { enabled });
      setStatus(enabled ? '已启用插件功能' : '已关闭插件功能', { tone: 'success' });
    } catch (error) {
      event.currentTarget.checked = !enabled;
      setStatus(`切换失败：${error?.message || error}`, { tone: 'error' });
    }
    await refreshPlugins();
  });

  // ⚠️ 委托挂在 #plugins-page 上，而那个元素是**长期存在**的（index.html 里的静态容器，
  // 渲染只换它的 innerHTML）：
  // 每次渲染都重绑会叠监听 → 一次点击发两次请求（同类问题见人物记忆页那次复审）。
  // 排序：也是每次渲染重绑（元素会被换掉）
  const sortBox = $('#plugins-sort');
  if (sortBox) {
    sortBox.value = pluginFilter.sort;
    sortBox.addEventListener('change', () => {
      pluginFilter.sort = sortBox.value || 'updated';
        safeRenderIndex();
    });
  }

  // 选文件：**每次渲染都要绑**（元素每次都换），并且每次进来先清掉上一次选的包
  const fileInput = $('#plugins-file');
  const fileNameBox = $('#plugins-file-name');
  const fileButton = $('#plugins-file-install');
  const setPickedFile = (file) => {
    pendingPluginFile = file || null;
    if (fileButton) fileButton.disabled = !file;
    if (fileNameBox) {
      fileNameBox.textContent = file
        ? `${file.name}（${(Number(file.size || 0) / 1024).toFixed(1)}KB）—— 装上后会给内容指纹，可核对`
        : '';
    }
  };
  setPickedFile(null);
  if (fileInput) fileInput.addEventListener('change', () => setPickedFile(fileInput.files?.[0] || null));
  const dropBox = $('#plugins-file-drop');
  if (dropBox) {
    dropBox.addEventListener('dragover', (event) => event.preventDefault());
    dropBox.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file) setPickedFile(file);
    });
  }

  // 搜索框：**每次渲染都要绑** —— 它自己在每次渲染时被换成新元素（页面正文整体换 innerHTML），
  // 而 delegationBound 守卫是给"长期存在的容器"（#plugins-page）用的。绑在守卫后面的话，
  // 离开插件页再回来搜索框就死了，但旧的搜索词还生效（列表被过滤、用户莫名其妙）。
  const searchBox = $('#plugins-search');
  if (searchBox) {
    searchBox.value = pluginFilter.q;
    searchBox.addEventListener('input', () => {
      pluginFilter.q = searchBox.value;
      safeRenderIndex();
    });
  }

  // 浏览器后退（含鼠标侧键 / 右键菜单后退）：回到目录，而不是退出插件页。
  // 绑在 window 上，所以用一次性旗标 —— bindPluginsSection 每次进页都会跑。
  // 单测的 window 桩可能没有 addEventListener（render-test 就是），所以先看它是不是函数
  if (!popstateBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    popstateBound = true;
    window.addEventListener('popstate', (event) => {
      // 插件页没在前台时不要处理：详情压过一条 history 之后切到别的页签，
      // 用户按后退时这个处理器会把状态改回目录（界面毫无变化），却白白吃掉一步历史。
      const pluginView = document.getElementById('view-plugins');
      if (!pluginView || !pluginView.classList.contains('active')) return;          // 页面被重建掉了就没什么可恢复的
      const next = String(event.state?.pluginDetail || '');
      closingDetail = false;
      pluginDetailId = next;
      stopQrPoll();
      // 回到目录时也要把面切回目录：用户可能是在详情里点了「已装/发布」页签再按后退的，
      // 不切的话 renderIndex 会渲染进那个 hidden 的容器里 —— 界面毫无变化，再按一次就退出控制台了
      if (pluginPane !== 'catalog') { pluginPane = 'catalog'; renderPane(); }
      safeRenderIndex();
    });
  }

  if (delegationBound) return;
  delegationBound = true;

  // 图标加载失败（404 / 被墙 / 不是图片）→ 回落到首字母。`error` 不冒泡，只能用捕获阶段。
  $('#plugins-page')?.addEventListener('error', (event) => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.closest?.('.plugin-mono')) return;
    const label = img.getAttribute('data-fallback') || '?';
    img.replaceWith(document.createTextNode(label));
  }, true);

  // 键盘：卡片/行是 role=button + tabindex=0，也要能按 Enter/Space 打开。
  // ⚠️ 必须和 click 委托一起放在 delegationBound 守卫**之后**：#plugins-page 是静态容器，
  // 每进一次插件页 bindPluginsSection 都会跑，绑在守卫前会一条条叠加 —— 按一次 Enter 打开 N 次、
  // 压 N 条 history，于是「返回目录」要连点 N 次才回得去（2026-10-17 审查抓到）。
  $('#plugins-page')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pluginDetailId) { event.preventDefault(); closePluginDetail(); return; }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.repeat) return;                                    // 按住不放不重复触发
    const target = event.target;
    if (target?.closest?.('[data-plugin-action]')) return;      // 动作按钮自己会处理 Enter
    if (target?.closest?.('[data-plugin-close]')) return;       // 关闭按钮同理
    const opener = target?.closest?.('[data-plugin-open]');
    if (!opener?.dataset?.pluginOpen || !$('#plugins-page')) return;
    event.preventDefault();
    openPluginDetail(opener.dataset.pluginOpen);
  });
  $('#plugins-page')?.addEventListener('click', async (event) => {

    // ⚠️ **动作按钮要先判**：data-plugin-open 挂在整张卡上（点说明也能进详情），
    // 先判 open 的话，点卡里的「安装」会被当成"打开详情"（按钮永远装不上去）。
    const button = event.target?.closest?.('[data-plugin-action]');
    const opener = event.target?.closest?.('[data-plugin-open]');
    const closer = event.target?.closest?.('[data-plugin-close]');
    const tagChip = event.target?.closest?.('[data-plugin-tag]');
    if (!button) {
      const writeSwitch = event.target?.closest?.('[data-pd-write-switch]');
      if (writeSwitch) {
        event.preventDefault();
        const block = writeSwitch.closest?.('[data-pd-settings]');
        // checkbox 的 checked 在点击后已翻转：以翻转后的值为准
        await toggleWriteSwitch(
          block?.getAttribute?.('data-pd-settings') || '',
          writeSwitch.getAttribute('data-pd-write-switch') || '',
          writeSwitch.checked === true
        );
        return;
      }
      const pendingBtn = event.target?.closest?.('[data-pd-approve-pending]');
      if (pendingBtn) {
        event.preventDefault();
        const block = pendingBtn.closest?.('[data-pd-settings]');
        await decidePendingApproval(
          block?.getAttribute?.('data-pd-settings') || '',
          pendingBtn.getAttribute('data-pd-approve-pending') || '',
          pendingBtn.getAttribute('data-pd-decision') === 'reject' ? 'reject' : 'approve',
          Number(pendingBtn.getAttribute('data-pd-uses')) || 1
        );
        return;
      }
      const qrLogin = event.target?.closest?.('[data-pd-qr-login]');
      if (qrLogin) {
        event.preventDefault();
        await startQrLogin(qrLogin.getAttribute('data-pd-qr-login') || '');
        return;
      }
      const qrPoll = event.target?.closest?.('[data-pd-qr-poll]');
      if (qrPoll) {
        event.preventDefault();
        await pollQrOnce(qrPoll.getAttribute('data-pd-qr-poll') || '');
        return;
      }
      const qrStop = event.target?.closest?.('[data-pd-qr-stop]');
      if (qrStop) {
        event.preventDefault();
        stopQrPoll();
        const block = qrStop.closest?.('[data-pd-settings]');
        const id = block?.getAttribute?.('data-pd-settings') || '';
        if (id) setSettingsStatus(id, '已取消等待扫码', '');
        return;
      }
      const probeBtn = event.target?.closest?.('[data-pd-probe]');
      if (probeBtn) {
        event.preventDefault();
        await probePlugin(probeBtn.dataset.pdProbe || '');
        return;
      }
      const secretClear = event.target?.closest?.('[data-pd-secret-clear]');
      if (secretClear) {
        event.preventDefault();
        const block = secretClear.closest?.('[data-pd-settings]');
        await clearPluginSecretField(block?.getAttribute?.('data-pd-settings') || '', secretClear.getAttribute('data-pd-secret-clear') || '');
        return;
      }
      const saveSettings = event.target?.closest?.('[data-pd-settings-save]');
      if (saveSettings) {
        event.preventDefault();
        await savePluginSettings(saveSettings.dataset.pdSettingsSave || '');
        return;
      }
      if (opener?.dataset?.pluginOpen && $('#plugins-page')) {
        if (opener.dataset.pendingJump) pendingJumpTarget = opener.dataset.pluginOpen;
        openPluginDetail(opener.dataset.pluginOpen);
        return;
      }
      if (closer?.dataset?.pluginClose && $('#plugins-page')) {
        closePluginDetail();
        return;
      }
      const pageBtn = event.target?.closest?.('[data-plugin-page]');
      if (pageBtn && $('#plugins-page')) {
        const totalPages = Math.max(1, Number(pageBtn.closest('.plugin-pagination')?.dataset.pages) || 1);
        const value = pageBtn.dataset.pluginPage;
        if (value === 'prev') pluginFilter.page = Math.max(1, (pluginFilter.page || 1) - 1);
        else if (value === 'next') pluginFilter.page = Math.min(totalPages, (pluginFilter.page || 1) + 1);
        else pluginFilter.page = Math.max(1, Number(value) || 1);
        safeRenderIndex();
        return;
      }
      if (tagChip && $('#plugins-page')) {
        const next = tagChip.dataset.pluginTag || '';
        pluginFilter.tag = pluginFilter.tag === next ? '' : next;
        // ⚠️ 必须**同时退出详情**：`renderIndex` 是先看 `pluginDetailId` 的，不清它的话
        // 这里只会把同一个详情页重画一遍 —— 筛选值确实写进去了，但页面纹丝不动，
        // 而且用户再点「← 返回目录」会发现目录莫名其妙处在筛选态（分面栏在详情里是藏着的，
        // 看不出什么时候设上的）。点标签的语义是"看这个标签下有什么"，那就得像参照那样回到列表。
        pluginDetailId = '';
        forgetDetailHistory();
        stopQrPoll();
        closeFiltersIfNarrow();
        safeRenderIndex();
        return;
      }

    // 页签（目录 / 已装 / 手动安装）与视图切换（卡片/列表）：不是"动作按钮"，各一条支路
      // 页签（目录 / 已装 / 手动安装）与视图切换（卡片/列表）：不是"动作按钮"，各一条支路。
      // ⚠️ 它们必须留在 `if (!button)` 里：动作按钮要最先判（点卡里的「安装」不能被页签支路吃掉）。
      const paneTab = event.target?.closest?.('[data-plugin-pane]');
      if (paneTab && $('#plugins-page')) {
        pluginPane = paneTab.dataset.pluginPane || 'catalog';
        renderPane();
        return;
      }
      const viewBtn = event.target?.closest?.('[data-plugin-view]');
      if (viewBtn && $('#plugins-page')) {
        pluginFilter.view = viewBtn.dataset.pluginView === 'list' ? 'list' : 'grid';
        document.querySelectorAll('[data-plugin-view]').forEach((btn) => {
          btn.classList.toggle('is-on', btn.dataset.pluginView === pluginFilter.view);
        });
        safeRenderIndex();
        return;
      }
      // 窄屏的「筛选」按钮：展开/收起左侧分面栏（宽屏这个按钮是 display:none，点不到）
      const filtersBtn = event.target?.closest?.('[data-plugin-filters]');
      if (filtersBtn && $('#plugins-page')) {
        filtersOpen = !filtersOpen;
        applyFilterPanel();
        return;
      }
      const onlyBox = event.target?.closest?.('[data-plugin-only-installed]');
      if (onlyBox && $('#plugins-page')) {
        pluginFilter.onlyInstalled = !pluginFilter.onlyInstalled;
        closeFiltersIfNarrow();
        safeRenderIndex();
        return;
      }
      const hideRevoked = event.target?.closest?.('[data-plugin-hide-revoked]');
      if (hideRevoked && $('#plugins-page')) {
        pluginFilter.hideRevoked = !pluginFilter.hideRevoked;
        closeFiltersIfNarrow();
        safeRenderIndex();
        return;
      }
      const rangeBox = event.target?.closest?.('[data-plugin-range]');
      if (rangeBox && $('#plugins-page')) {
        // 再点一次当前范围 = 回到"全部"（与标签 chip 同一个手感）
        const next = rangeBox.dataset.pluginRange || 'all';
        pluginFilter.range = pluginFilter.range === next ? 'all' : next;
        closeFiltersIfNarrow();
        safeRenderIndex();
        return;
      }
      const catBox = event.target?.closest?.('[data-plugin-category]');
      if (catBox && $('#plugins-page')) {
        const next = catBox.dataset.pluginCategory || '';
        pluginFilter.category = pluginFilter.category === next ? '' : next;
        closeFiltersIfNarrow();
        safeRenderIndex();
        return;
      }
      const clearBox = event.target?.closest?.('[data-plugin-clear]');
      if (clearBox && $('#plugins-page')) {
        pluginFilter.tag = '';
        pluginFilter.category = '';
        pluginFilter.q = '';
        pluginFilter.onlyInstalled = false;
        pluginFilter.hideRevoked = false;
        pluginFilter.range = 'all';
        const search = $('#plugins-search');
        if (search) search.value = '';
        closeFiltersIfNarrow();
        safeRenderIndex();
        return;
      }
      return;
    }
    if (!$('#plugins-page')) return;   // 只在插件页生效
    if (button.dataset.pluginPage) {
      const value = button.dataset.pluginPage;
      const totalPages = Math.max(1, Number(button.closest('.plugin-pagination')?.dataset.pages) || 1);
      if (value === 'prev') pluginFilter.page = Math.max(1, (pluginFilter.page || 1) - 1);
      else if (value === 'next') pluginFilter.page = Math.min(totalPages, (pluginFilter.page || 1) + 1);
      else pluginFilter.page = Math.max(1, Number(value) || 1);
      safeRenderIndex();
      return;
    }
    const action = button.dataset.pluginAction;
    const id = button.dataset.pluginId || '';
    if (action === 'uninstall') {
      const ok = await askForConfirmation(`确定卸载插件「${id}」？代码会被移走。`);
      if (!ok) return;
      // 第二次问数据：默认保留（重装后还在），只有明确点「确定」才连凭据一起删
      const purge = await askForConfirmation(
        '同时删除这个插件的数据与凭据吗？\n\n'
        + '「确定」= 一并删除（重装后不会恢复）；「取消」= 只卸载代码，数据保留。'
      );
      button.disabled = true;
      try {
        await post('/api/plugins/uninstall', { id, confirm: true, purgeData: purge });
        setStatus(purge ? `已卸载 ${id}（代码与数据都已删除）` : `已卸载 ${id}（代码已移走，数据保留）`,
          { tone: 'success' });
      } catch (error) { setStatus(`卸载失败：${error?.message || error}`, { tone: 'error' }); }
      await refreshPlugins();
      return;
    }
    button.disabled = true;
    try {
      if (action === 'install' || action === 'upgrade') {
        if (action === 'upgrade') {
          // 先预览权限 diff：升级后权限面一变，旧授权就不能继续用了。
          setStatus(`正在检查 ${id} 的权限差异…`, { busy: true });
          const preview = await post('/api/plugins/upgrade-preview', { id });
          const diff = preview.diff;
          if (diff?.permissionChanged) {
            const lines = (diff.summary || []).join('\n') || '（权限面有变化）';
            const ok = await askForConfirmation(
              `升级 ${id} 会改变插件权限：\n\n${lines}\n\n`
              + '升级后相关写开关会自动关闭、对象级批准与待批会清空，需要重新授权。确认升级？'
            );
            if (!ok) {
              setStatus('已取消升级', { tone: 'info' });
              button.disabled = false;
              return;
            }
            setStatus(`正在升级 ${id}…`, { busy: true });
            await post('/api/plugins/install', { id, expectedDiffHash: diff.diffHash });
          } else {
            setStatus(`正在升级 ${id}…`, { busy: true });
            await post('/api/plugins/install', { id });
          }
        } else {
          setStatus(`正在安装 ${id}…`, { busy: true });
          await post('/api/plugins/install', { id });
        }
        setStatus(action === 'upgrade'
          ? `已升级 ${id}（旧版留在 plugins/.backup-* 里，确认没问题可以删）`
          : `已安装 ${id} —— 还要点「启用」才会跑（装上 ≠ 授权）`, { tone: 'success' });
      } else if (action === 'install-file') {
        const file = pendingPluginFile;
        if (!file) { setStatus('先选一个包文件', { tone: 'error' }); button.disabled = false; return; }
        if (Number(file.size || 0) > 5 * 1024 * 1024) { setStatus('文件超过 5MB 上限', { tone: 'error' }); button.disabled = false; return; }
        setStatus(`正在读取 ${file.name}…`, { busy: true });
        const base64 = await fileToBase64(file);
        setStatus('正在校验并换入…', { busy: true });
        const result = await post('/api/plugins/install-file', { fileName: file.name, base64 });
        setStatus(`已装 ${result.id} v${result.version}（来源：本地文件：${result.fileName}）`
          + `｜包内容 sha256 ${String(result.sha256 || '').slice(0, 16)}…`, { tone: 'success' });
        // 装完直接问要不要启用：小白最容易卡在"装完了以为就好了"
        if (await askForConfirmation(`「${result.id}」已经装上了。现在就启用它吗？（启用后模型才能用它的工具）`)) {
          await post('/api/plugins/toggle', { id: result.id, enabled: true });
          setStatus(`已启用 ${result.id}`, { tone: 'success' });
        }
        setPickedFile(null);
      } else if (action === 'install-url') {
        // 手动填地址：地址与 sha256 两项都要，且当场校验形状 —— 让用户在点之前就知道缺东西，
        // 而不是等服务端报"必须提供 sha256"
        const url = String($('#plugins-manual-url')?.value || '').trim();
        const sha256 = String($('#plugins-manual-sha')?.value || '').trim().toLowerCase();
        if (!/^https?:\/\//i.test(url)) { setStatus('地址要以 http:// 或 https:// 开头', { tone: 'error' }); button.disabled = false; return; }
        if (!/^[0-9a-f]{64}$/.test(sha256)) { setStatus('sha256 要填 64 位十六进制（打包脚本会打印）', { tone: 'error' }); button.disabled = false; return; }
        setStatus('正在下载并校验…', { busy: true });
        const result = await post('/api/plugins/install', { url, sha256 });
        setStatus(`已安装 ${result?.id || ''} —— 还要点「启用」才会跑（装上 ≠ 授权）`, { tone: 'success' });
      } else if (action === 'enable' || action === 'disable') {
        await post('/api/plugins/toggle', { id, enabled: action === 'enable' });
        setStatus(`${action === 'enable' ? '已启用' : '已停用'} ${id}`, { tone: 'success' });
      } else if (action === 'rollback') {
        const ok = await askForConfirmation(`把「${id}」回退到上一次升级前的版本？当前版本会被挪到 plugins/.removed-* 里（不删）。`);
        if (!ok) { button.disabled = false; return; }
        const result = await post('/api/plugins/rollback', { id });
        setStatus(`已回退 ${id} 到 ${result.rolledBackTo}${result.version ? `（v${result.version}）` : ''}`, { tone: 'success' });
      } else if (action === 'reload') {
        await post('/api/plugins/reload', { id });
        setStatus(`已重载 ${id}`, { tone: 'success' });
      }
    } catch (error) {
      setStatus(`操作失败：${error?.message || error}`, { tone: 'error' });
    } finally {
      // 「安装 / 装这个文件」是**静态骨架**里的按钮，不会被 refreshPlugins 重画 ——
      // 不复位的话，装完一次（或失败一次）就永久变灰，连重试都点不了。
      // 文件那个按钮的语义是"选了文件才能点"，所以跟着 pendingPluginFile 走。
      if (action === 'install-url') button.disabled = false;
      else if (action === 'install-file') button.disabled = !pendingPluginFile;
    }
    await refreshPlugins();
  });
}

/**
 * 进插件页：骨架不在就重建 + 绑控件，然后拉一次数据把三块填上。
 *
 * `pluginDetailId` 在进页时清掉：它是模块级状态，不清的话"上次打开过某个插件、切走再回来"
 * 会直接落进那个详情页 —— 看起来像卡住了（何况插件可能已经被卸载/撤回）。
 */
async function loadPluginsPage({ force = false } = {}) {
  const page = $('#plugins-page');
  if (!page) return null;
  // 哨兵用真实存在的骨架锚点：原来写的是 #plugins-stats（那个元素第五版已经删了），
  // 条件恒真 = 每次进页都整页重建 —— 行为上没错，但那是个假守卫（改了 id 没改引用）。
  if (force || !page.querySelector('#plugins-head')) {
    // 页面整页重建会连同扫码面板一起销毁：旧的轮询定时器必须停，否则会在后台
    // 对着已经不存在的 DOM 每 3 秒打一次插件接口。
    stopQrPoll();
    pluginDetailId = '';
    forgetDetailHistory();
    pendingPluginFile = null;
    page.innerHTML = renderPluginsPage();
    bindPluginsSection();
    // 视图按钮的初始态跟着 pluginFilter.view（列表/卡片是用户偏好，切走再回来保留）
    document.querySelectorAll('[data-plugin-view]').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.pluginView === pluginFilter.view);
    });
  }
  void loadPendingBanner();
  return refreshPlugins();
}

// 导出统一放末尾（本仓 ui/ 的约定：test/ui-module-graph.test.mjs 按 ExportNamedDeclaration 的
// specifiers 收集名字，而 export function 那种写法没有 specifiers，它收不到）
export { renderPluginsPage, loadPluginsPage, refreshPlugins, bindPluginsSection, capText };
