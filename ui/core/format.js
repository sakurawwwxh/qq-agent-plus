// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';

// ── 工具函数 ──
// 控制台标识头：证明请求来自本控制台页面，而非外部网页冒用浏览器。
// 带自定义头的请求必须过 CORS 预检，天然挡住跨站脚本/表单的静默读取。

import { ASR_SERVICES, MODEL_SERVICES_UI } from './constants.js';
import { esc } from './dom.js';
import { state } from './state.js';
/** 数字加千分位（token 计数用）。 */
const fmtTok = (n) => (Number(n) || 0).toLocaleString('zh-CN');

/**
 * 金额格式化（成本用）。
 * 成本经常是小额（几分钱），固定两位小数会全显示成 ¥0.00 看不出差别，
 * 所以小于 1 时多给两位有效数字。
 */
const fmtYuan = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  if (Math.abs(v) < 1) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(2)}`;
};

// 统一按 **Asia/Shanghai** 显示：服务端业务时间（说说排期、日报、提醒）一律按上海时间解释，
// 另外三处显示（impressionMetaLabel / moments 定时提醒 / status 时间控制）也都钉死了时区，
// 只有覆盖面最广的这个用浏览器本地时区 —— 管理员从非 UTC+8 的机器打开控制台时，
// 同一屏会出现两套时间线（2026-10-03 全量审查）。格式化器缓存一次，别每次调用重建。
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});

function fmtTime(ts) {
  // 坏值（负数/纳秒级/非数字）会让 toLocaleString 抛 RangeError，整页挂掉 → 兜底成 '-'
  // （与 impressionMetaLabel 的 ?? 兜底同一口径，那个坑本仓已经踩过一次）
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0 || n > 8.64e15) return '-';
  const p = (x) => String(x).padStart(2, '0');
  const parts = TIME_FMT.formatToParts(new Date(n));
  const get = (type) => Number(parts.find((x) => x.type === type)?.value ?? 0);
  return `${p(get('month'))}-${p(get('day'))} ${p(get('hour'))}:${p(get('minute'))}`;
}

/**
 * 图片生成每小时上限：与运行期 imageGenMaxPerHour 同一口径（非正数/坏值按默认 6，而不是夹到 1）。
 * 原来前端是 clampInt 式的 Math.max(1, …)：手填 -5 会存成"每小时 1 张"——比默认更严格，
 * 与 ASR 那次修过的坑同型（2026-10-03 全量审查）。
 */
function normalizeImageGenMax(value, fallback = 6) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/**
 * 版本标记的显示口径。提交是 40 位 sha（显示前 12 位）；用未提交的本地树部署时，
 * data/deployed-revision 记的是 `source-<UTC 时间戳>` —— 直接截前 12 个字符会显示成
 * `source-20260` 这种看不懂的串，用户就看不出"当前跑的不是某个提交"（2026-09-29 实测）。
 */
function formatRevision(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '-';
  const exported = /^source-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (exported) {
    const at = Date.parse(`${exported[1]}-${exported[2]}-${exported[3]}T${exported[4]}:${exported[5]}:${exported[6]}Z`);
    return Number.isFinite(at) ? `未提交版本 · ${fmtTime(at)}` : '未提交版本';
  }
  return raw.slice(0, 12);
}

/**
 * 版本徽标：`v0.7.5 · 76b2a6ca2ebb`（没有版本号时退化成只有提交号）。
 * 控制页「当前版本」原来只给提交号，用户看不出"这是哪个版本" —— 版本号在 package.json 里，
 * 由 /api/status 下发（见 ui/status-refresh.js）。
 */
function versionWithRevision(version, value) {
  const rev = formatRevision(value);
  const v = String(version ?? '').trim();
  return v ? `v${v} · ${rev}` : rev;
}

// 与 fmtTime 同一时区口径（Asia/Shanghai）：会话页"列表时间"与"详情开始/结束时间"同屏出现，
// 两处一个本地一个上海会让同一批运行对不上（2026-10-03 复审）。
const CLOCK_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

function fmtClock(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0 || n > 8.64e15) return '-';
  const part = (type) => String(Number(CLOCK_FMT.formatToParts(new Date(n)).find((x) => x.type === type)?.value ?? 0)).padStart(2, '0');
  return `${part('hour')}:${part('minute')}:${part('second')}`;
}

function fmtRemainingMs(ms) {
  const seconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

// ── OneBot 连接失败的人话解释 ──
// 后端在 /api/status 的 onebot.error 里记着最近一次连接失败的原因（例如
// "connect ECONNREFUSED 127.0.0.1:3001"），但界面上以前只写"未连接"，用户只能猜。
// 这里把常见错误翻成能照着做的短句；原文附在括号里，方便直接复制去求助。
function onebotIssueText(ob, { withRaw = true } = {}) {
  if (!ob || ob.connected) return '';
  const raw = String(ob.error || '').trim();
  if (!raw) return ob.everConnected ? '连接已断开，正在自动重连' : '还没连上协议端，正在重试';
  let hint = '连接失败';
  if (/ECONNREFUSED/i.test(raw)) hint = '协议端没在这个端口监听（服务没启动或端口不对）';
  else if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) hint = '这个地址解析不了（WS 地址可能写错了）';
  else if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(raw)) hint = '连不到那台机器（地址或防火墙）';
  else if (/\b(401|403)\b|unauthorized|forbidden/i.test(raw)) hint = '对方拒绝了连接，多半是令牌不一致（协议端 onebot.json 的 accessToken 要和控制台里的 WS 令牌一致）';
  else if (/\b404\b|Unexpected server response/i.test(raw)) hint = '对方不是 WebSocket 协议端（地址或端口填错了）';
  return withRaw ? `${hint}（${raw}）` : hint;
}

// 设置页「OneBot」那一块的状态行：那一页就是来修"连不上"的地方，
// 所以当前状态和失败原因直接摊开写，不用去别处找。
function onebotStatusLineHtml() {
  const ob = state.status?.onebot;
  return ob?.connected
    ? `<div class="hint success">当前状态：已连接${ob.self ? `（${esc(ob.self.nickname)}）` : '（但没取到登录信息，确认协议端的 QQ 已登录）'}</div>`
    : `<div class="hint error">当前状态：未连接 —— ${esc(onebotIssueText(ob) || '正在等待首次连接')}</div>`;
}

function serviceUrl(port, path = '/') {
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
  const hostname = location.hostname || new URL(location.href).hostname;
  return `${protocol}//${hostname}:${port}${path}`;
}

// 服务卡片的状态：旧架构（DSH / Bridge）没配置端点时是「未部署」，不是故障 ——
// 本仓库的部署栈不含它们（见 docs/LINUX.md），部署脚本也不会起。
// 配置过（后端给了 optional+configured）却连不上，才照旧报「不可达」。
function serviceTileState(id, status) {
  const online = id === 'agent' || status?.online === true;
  if (online) return { text: '在线', cls: 'online' };
  if (!status) return { text: '检测中', cls: 'offline' };
  if (status.optional === true && status.configured === false) return { text: '未部署', cls: 'idle' };
  return { text: '不可达', cls: 'offline' };
}

/** 旧架构服务是否落在本部署里（没配置 = 不显示指向它的入口）。 */
function legacyServiceDeployed(statuses, id) {
  const status = statuses.get(id);
  return !(status?.optional === true && status?.configured === false);
}

function formatElapsed(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${String(total % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
}

// Release 说明与上下文消息都是 markdown；先整体转义，再把标题/加粗/列表替换成最小样式，
// 避免把 --- 之类的分隔线与标题混在一起时出现乱码感。
//
// `rich`（插件 README 走它）比默认档多做三件事 —— 都只在"长文档"里成立：
//   · 标题真成标题（默认档 `##` → `<strong>`）；
//   · `- x` 成 `<ul><li>`（默认档只把 `- ` 换成 `• `）；
//   · `[文字](链接)` 成可点的 `<a>`（默认档原样显示）。
// 为什么默认档**不**跟着改：它最大的消费者是会话页的上下文检查器，那里看的是**原文本**——
// 系统提示词的分节与缩进本身就是被检查的东西，把缩进折进 `<ul>` 会丢掉一层结构。
// 两条路共用同一份 esc 前提与同一次围栏切段，不是两份渲染器。
function formatMinimalMarkdown(body, { rich = false } = {}) {
  const escaped = esc(String(body || '').trim());
  // 先整体转义、再按围栏切段（不是先切再转义）：围栏内的内容不该再被当成 markdown 解析
  //（行首的 * 或 # 在代码里是字面量），而它同样必须已经转义过 —— 这是本函数唯一的安全前提。
  const parts = escaped.split(/^```[^\n]*\n?/gm);
  // split 的产物里，奇数段是围栏内内容，偶数段是普通行文
  return parts.map((chunk, index) => {
    if (index % 2 === 1) return `<pre class="md-pre"><code>${chunk.replace(/\n$/, '')}</code></pre>`;
    return rich ? renderMarkdownChunk(chunk) : renderPlainChunk(chunk);
  }).join('');
}

/** 默认档：只换符号，行结构与缩进一律保留（诊断视图要的是原文本的样子）。 */
function renderPlainChunk(chunk) {
  return chunk
    .replace(/^#{1,6}\s*(.+)$/gm, '<strong>$1</strong>')
    .replace(/^[*-]\s+/gm, '• ')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * 段内软换行怎么合：**按 CommonMark/GitHub 的语义合成一行**（软换行 = 空格），只有
 * 行尾两个空格才是硬换行（`<br>`）。
 *
 * 为什么不保留原换行：这是照参照做的决定。GitHub / Obsidian / VS Code 渲染同一份 README
 * 都会把软换行折成一行 —— 作者们按 80 列硬折的行，在详情页里逐行断句就成了"每行半句"的
 * 参差文本（实测中文 README 尤其难看）。语义上也没丢东西：换行位置不是作者要表达的内容。
 *
 * 唯一比参照多做的一点：**中文之间不插空格**。按空格合的话会出现「…时， 模型可以…」这种
 * 全角标点后面多一个空格的样子，中文排版里那看着像错字。两侧都是中日韩字符就直接接上。
 */
function joinParagraphLines(lines) {
  let out = lines[0].trim();
  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1];
    const next = lines[i].trim();
    if (/ {2,}$/.test(prev)) { out += `\n${next}`; continue; }            // 硬换行
    const left = out.slice(-1);
    const glue = (CJK.test(left) && CJK.test(next.slice(0, 1))) ? '' : ' ';
    out += glue + next;
  }
  return out;
}

/**
 * 普通行文那一段的最小 markdown（围栏外）。按行归块：标题 / 无序列表 / 有序列表 / 段落。
 *
 * 为什么要有标题层级：README 是**长文档**，原来 `##` 只渲染成 `<strong>` —— 一整页粗体小字，
 * 读起来是一堵墙（VS Code / Obsidian 的插件详情页都是"标题就是标题"）。
 * 为什么段落要包 `<p>`：详情页的 README 不再用 `white-space: pre-wrap`（标题与列表要正常折行），
 * 于是裸文本里的换行会被 HTML 折成一个空格 —— `1. 甲 2. 乙` 那种两行会挤成一行。所以：
 * 空行分段、列表行归 `<ul>`/`<ol>`、其余按上面的软换行规则合段。
 * 链接：README 里 `[Open-Meteo](https://open-meteo.com/)` 这种原来原样显示成文字。
 * ⚠️ 链接只收 http(s)：README 是**第三方内容**（插件作者的仓库里写什么都有），
 * `javascript:`/`data:` 拼进 href 就是在持有控制台令牌的页面上执行别人的脚本。
 */
function renderMarkdownChunk(chunk) {
  const lines = chunk.split('\n');
  const out = [];
  let list = null;      // { tag: 'ul' | 'ol', items: [] } —— 连着几行同一种符号才算一个列表
  let para = [];
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag} class="md-${list.tag}">${list.items.join('')}</${list.tag}>`);
    list = null;
  };
  // ⚠️ 行内处理要**在合好的整段上做、最后才换 `<br>`**：加粗可以跨软换行（真 README 里有
  // `…会注明**实际用了哪家、\n汇率是哪一天的**。` 这种），逐行处理的话那一对 `**` 永远配不上，
  // 页面上就明晃晃留着两个星号。
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p class="md-p">${inlineMarkdown(joinParagraphLines(para)).replace(/\n/g, '<br>')}</p>`);
    para = [];
  };
  const both = () => { flushList(); flushPara(); };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^\s*[*-]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (heading) {
      both();
      // README 的一级标题在详情页里已经由 hero 顶着了，所以整体降一档：`#` → h3
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level} class="md-h">${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (bullet || ordered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
    } else if (!line.trim()) {
      both();
    } else {
      flushList();
      // 保留原行（不 trim）：`joinParagraphLines` 要靠行尾的两个空格认硬换行
      para.push(line);
    }
  }
  both();
  return out.join('\n');
}

/** 行内：加粗 / 行内码 / 链接（链接只收 http(s)）。
 *
 * ⚠️ URL 的字符类里**必须排掉 `*` 与反引号**：三趟替换是顺序跑在同一串上的，链接先跑，
 * 于是生成的 `<a href="…">` 会被后两趟扫到 —— URL 里只要有一个 `*`，加粗那趟就能从 href
 * 内部一直吃到行尾，把标签结构撕坏（`[x](https://a**b)**` → href 里钻出 `<strong>`）。
 * 宁可这种 URL 不成为链接（原样显示），也不能生成坏标记。
 */
function inlineMarkdown(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s*`]+)\)/g,
      (whole, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    // `[^*]` 允许跨换行：段内软换行之间的一对 `**` 是真 markdown（见 flushPara 的注释）。
    // 它跨不过 `*` 本身，所以同一行里 `**a** 和 **b**` 仍然是两对，不会吃成一个。
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}
// 旧名沿用（会话页在用它渲染 Release 说明与上下文消息）：同一份实现，围栏处理它也跟着有
const formatReleaseNotes = formatMinimalMarkdown;

// 插件 README 与 Release 说明是同一类文本（作者写的 markdown，都要"先整体转义、再换少量样式"）。
// 用同一个函数而不是各写一份：这类渲染器多一份就多一个注入面 —— 这里的中性名字是给调用方看的，
// 实现与 esc 纪律完全共用（改一处两处都变）。

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

function fmtWaitRemain(untilMs) {
  const remain = Math.max(0, Number(untilMs) - Date.now());
  return `${(remain / 1000).toFixed(1)}s`;
}

function fmtRate(rate, available) {
  return available ? `${(Math.min(1, Math.max(0, Number(rate) || 0)) * 100).toFixed(1)}%` : '-';
}

/**
 * 在内置价格表里匹配模型（前端版）。
 *
 * 前端拿不到 src/pricing/model-prices.js 的导出（那是 Node 端模块），所以这里实现一份
 * 与后端 matchModelId 完全相同的逻辑（改后端时这里要一起改）：
 *   候选名（原样 → 去渠道前缀 → 去叫法后缀/日期后缀 → 点号归并）
 *   → 别名 → 表内精确 → 前缀匹配（取最长）
 * 返回条目并带上 confidence/via：'alias'（按别名）/ 'fuzzy'（近似）要在界面上标出来。
 * 别名表来自 /api/model-prices 的 aliases（内置 + 远程）。
 */
function matchPriceTable(modelId, table, aliases = null) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw) return null;
  const list = Array.isArray(table) ? table : Object.entries(table || {}).map(([id, e]) => ({ id, ...e }));
  if (!list.length) return null;
  const aliasMap = aliases || state.modelPrices?.aliases || {};

  const byId = new Map();
  for (const x of list) {
    const key = String(x?.id ?? '').toLowerCase();
    if (key) byId.set(key, x);
  }

  // 候选名（与后端 modelIdCandidates 一致）
  const candidates = [];
  const push = (id, confidence, via) => {
    if (id && !candidates.some((c) => c.id === id)) candidates.push({ id, confidence, via });
  };
  const suffixes = [':free', ':beta', ':latest', '-free', '-beta', '-latest',
    '-preview', '-exp', '-experimental', '-thinking', '-nothink', '-nonthinking', '-non-thinking'];
  push(raw, 'exact', '');
  const bare = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
  if (bare !== raw) push(bare, 'exact', '去渠道前缀');
  for (const base of [raw, bare]) {
    let id = base;
    for (const suffix of suffixes) {
      if (id.endsWith(suffix) && id.length > suffix.length) id = id.slice(0, -suffix.length);
    }
    if (id !== base) push(id, 'normalized', '去掉叫法后缀');
    const noDate = id.replace(/-(?:\d{4}|\d{6}|\d{8})$/, '');
    if (noDate !== id) push(noDate, 'normalized', '去掉日期快照后缀');
  }
  for (const cand of [...candidates]) {
    const minor = cand.id.replace(/v(\d+)\.(\d+)/g, 'v$1');
    if (minor !== cand.id) push(minor, 'fuzzy', '点号版本归并');
    const dashed = cand.id.replace(/\./g, '-');
    if (dashed !== cand.id) push(dashed, 'fuzzy', '点号转连字符');
  }

  for (const cand of candidates) {
    const alias = aliasMap[cand.id];
    if (alias && byId.has(alias)) {
      return { ...byId.get(alias), matched: alias, confidence: 'alias', via: `${cand.id} → ${alias}` };
    }
    if (byId.has(cand.id)) {
      return { ...byId.get(cand.id), matched: cand.id, confidence: cand.confidence, via: cand.via };
    }
  }

  for (const cand of candidates) {
    let best = null;
    for (const key of byId.keys()) {
      if (
        cand.id === key
        || cand.id.startsWith(`${key}/`) || cand.id.startsWith(`${key}-`)
        || cand.id.startsWith(`${key}@`) || cand.id.startsWith(`${key}:`)
      ) {
        if (!best || key.length > best.length) best = key;
      }
    }
    if (best) return { ...byId.get(best), matched: best, confidence: 'prefix', via: '前缀匹配' };
  }
  return null;
}

/**
 * 渠道倍率：没填 = 1；填了 0 就是 0（免费渠道）。与后端 parseMultiplier 保持一致 ——
 * 不能用 `Number(x) || 1`，那会把用户填的 0 悄悄变成原价。
 */
function mulOf(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 1;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** 价格展示：最多 4 位小数并去掉尾随 0（0.0500 → 0.05）。 */
function priceTxt(value) {
  return (Number(value) || 0).toFixed(4).replace(/\.?0+$/, '') || '0';
}

/**
 * 手填的一条价目算不算"填了价"：判据是写没写 in/out 字段（0 是合法价，代表免费），
 * 与后端 hasManualPrice 保持一致。
 */
function hasOwnPrice(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (String(entry.billing ?? '').trim()) return true;
  for (const key of ['in', 'out']) {
    const value = entry[key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (Number.isFinite(Number(value))) return true;
  }
  return false;
}

/**
 * 前端版查价链路（与后端 resolveModelPrice 保持一致，改后端时要一起改）：
 *   ① 渠道价 modelPrices[渠道：模型]  ② 自定义价 modelPrices[模型]
 *   ③ 官方/远程价格表（useOfficialPrice !== false 时）  ④ 全局兜底单价  ⑤ 未定价
 * 返回里带 kind：actual（实付）/ estimate（估算）/ unpriced（未定价），界面据此标口径。
 *
 * @param {string} model 模型 id
 * @param {string} vendor 渠道名（可空）
 * @param {object} [overrides] 覆盖 config.api 的实时值（如界面上的开关）
 */
function effectivePriceFor(model, vendor, overrides = null) {
  const api = { ...((state.config || {}).api || {}), ...(overrides || {}) };
  const customMap = api.modelPrices || {};
  const id = String(model || '').trim();
  if (!id) {
    return { in: 0, out: 0, cached: 0, source: 'unmatched', kind: 'unpriced', unpriced: true, confidence: 'none', via: '', locked: true, billing: 'token' };
  }

  // 没有临时覆盖时，优先用后端算好的权威结果（渠道价目表那层只有后端知道）
  const detail = state.modelPrices?.currentDetail;
  if (!overrides && detail && String(detail.model || '') === id
    && String(detail.vendor || '') === String(vendor || '')) {
    return { ...detail };
  }

  // 计费方式（与后端 billingOf 一致）
  const billingShape = (entry) => {
    const raw = String(entry?.billing ?? '').trim().toLowerCase();
    if (raw === 'flat') {
      return { billing: 'flat', amount: Number(entry.amount) || 0, period: String(entry.period) === 'day' ? 'day' : 'month' };
    }
    if (raw === 'none') return { billing: 'none', amount: 0, period: 'month' };
    return { billing: 'token', amount: 0, period: 'month' };
  };

  const customShape = (entry, source, matched, via) => {
    const bill = billingShape(entry);
    const perToken = bill.billing === 'token';
    return {
      in: perToken ? Number(entry.in) || 0 : 0,
      out: perToken ? Number(entry.out) || 0 : 0,
      cached: perToken ? (entry.cached == null ? Number(entry.in) || 0 : Number(entry.cached) || 0) : 0,
      peak: perToken ? (entry.peak || null) : null,
      source,
      matched,
      via,
      confidence: source,
      kind: 'actual',
      unpriced: false,
      locked: false,
      ...bill
    };
  };

  if (vendor) {
    const key = `${vendor}：${id}`;
    const hit = customMap[key];
    if (hasOwnPrice(hit)) return customShape(hit, 'channel', key, `渠道价（${vendor}）`);
  }
  const own = customMap[id];
  if (hasOwnPrice(own)) return customShape(own, 'custom', id, '自定义价');

  // 账户口径：按月付（与后端 ③ 一致）—— 固定月费，不按 token 算
  const costMode = String(api.costMode || 'official');
  const monthlyFee = Number(api.costMonthlyFee) || 0;
  if (costMode === 'subscription' && monthlyFee > 0) {
    return {
      in: 0, out: 0, cached: 0, peak: null, image: null,
      billing: 'flat', amount: monthlyFee, period: 'month',
      source: 'subscription', matched: null, via: `按月付 ¥${monthlyFee}/月`,
      confidence: 'manual', kind: 'actual', unpriced: false, locked: false
    };
  }

  if (api.useOfficialPrice !== false) {
    const hit = matchPriceTable(id, state.modelPrices?.prices || [], state.modelPrices?.aliases || null);
    if (hit) {
      const remote = hit.remote === true;
      // 渠道倍率（与后端 ⑤ 一致）：官方/远程表的价按用户声明的倍率折算，
      // 折算后是"实付"口径，所以卡片不能再按"官方估算"解释。
      const mul = costMode === 'multiplier' ? mulOf(api.costMultiplier) : 1;
      const discounted = mul !== 1;
      const scale = (value) => Number((((Number(value) || 0) * mul)).toFixed(6));
      const peak = hit.peak
        ? (discounted
          ? { in: scale(hit.peak.in), out: scale(hit.peak.out), cached: hit.peak.cached == null ? scale(hit.cached) : scale(hit.peak.cached) }
          : hit.peak)
        : null;
      const bill = billingShape(hit);
      const perToken = bill.billing === 'token';
      return {
        in: perToken ? scale(hit.in) : 0,
        out: perToken ? scale(hit.out) : 0,
        cached: perToken ? (hit.cached == null ? scale(hit.in) : scale(hit.cached)) : 0,
        peak: perToken ? peak : null,
        image: perToken ? (hit.image || null) : null,
        src: hit.src || '',
        source: discounted ? 'multiplier' : (remote ? 'remote' : 'official'),
        matched: hit.matched,
        confidence: discounted ? 'manual' : (hit.confidence || 'exact'),
        via: discounted ? `官方价 ×${mul}` : (hit.via || ''),
        kind: discounted ? 'actual' : 'estimate',
        unpriced: false,
        locked: discounted ? false : !remote,
        ...bill
      };
    }
    return { in: 0, out: 0, cached: 0, source: 'unmatched', kind: 'unpriced', unpriced: true, confidence: 'none', via: '', locked: true, billing: 'token' };
  }

  const fi = Number(api.priceInputPerM) || 0;
  const fo = Number(api.priceOutputPerM) || 0;
  if (fi || fo) {
    return {
      in: fi,
      out: fo,
      cached: Number(api.priceCachedPerM) || fi,
      source: 'manual',
      matched: null,
      via: '全局兜底单价',
      confidence: 'manual',
      kind: 'estimate',
      unpriced: false,
      locked: false,
      billing: 'token',
      amount: 0,
      period: 'month'
    };
  }
  return { in: 0, out: 0, cached: 0, source: 'unmatched', kind: 'unpriced', unpriced: true, confidence: 'none', via: '', locked: false, billing: 'token' };
}

/**
 * 清单条数归一化，必须与运行时的读法一致（prompt.js 是"非正数/坏值按 10"，buildStickerContext 夹 1~60）：
 * 手改成 -5 实际生效的是 10，界面就不能显示 1 —— 否则保存一下就把用户的值改成 1 了。
 */
function normalizeStickerMax(current) {
  const n = Number(current);
  if (!Number.isFinite(n) || n <= 0) return 3;
  return Math.min(60, Math.max(1, Math.round(n)));
}

/**
 * 每小时收藏上限归一化（控制台口径 1~60，非正/坏值按默认 10）：与运行时读法
 * max(1, n||10) 对齐的只有"非正/坏值按 10"这一半，上限 60 是界面收口（填更大按 60 回填）。
 */
function normalizeStickerCollectMax(current) {
  const n = Number(current);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(60, Math.max(1, Math.round(n)));
}

/** 服务预设下方的初始说明：与默认选中项一致（能认出当前地址就显示那家的说明）。 */
function initialServiceNote(c) {
  const matched = uiServiceOfUrl(c.api?.baseUrl);
  if (matched) return matched.note;
  return '先选一家（自动填好 Base URL，可改）；没有你的服务商就选「自定义 / 自建」，直接填下面的地址。模型点「获取列表」从服务商官网拉。';
}

function hostOfUrl(u) {
  try { return new URL(String(u || '').trim()).host.toLowerCase(); } catch { return ''; }
}

function uiServiceOfUrl(url) {
  try {
    const host = new URL(String(url || '')).host.toLowerCase();
    return MODEL_SERVICES_UI.find((s) => (s.hosts || []).includes(host)) || null;
  } catch { return null; }
}

/** 服务地址的主机名 —— 凭据的绑定粒度（同一主机换路径不算换家）；填得不合法就返回空串。 */
function asrHostOf(url) {
  try { return new URL(String(url || '').trim()).host.toLowerCase(); } catch { return ''; }
}

/** 语音转写的凭据槽位（与后端 asrCredentialSlot 同口径）：OpenAI 兼容按主机分家，其余按 provider。 */
function asrSlotOf(provider, baseUrl) {
  const p = String(provider || '').trim().toLowerCase() || 'openai';
  return p === 'openai' ? `openai|${asrHostOf(baseUrl)}` : p;
}

/** 按 provider + 地址反查当前是哪家（改过就落到「自定义」）。 */
function asrServiceOf(provider, baseUrl) {
  const norm = (v) => String(v || '').trim().replace(/[/]+$/, '').toLowerCase();
  // 判据（越简单越不容易错）：一个 provider 只对应一家 → 就是它（地址填没填、填得对不对都不影响归属）；
  // 一个 provider 对应多家（只有 openai 家族）→ 按地址区分，认不出即"自定义"。
  // ⚠️ 之前写成「id === provider 且 baseUrl 为空」，于是 aliyun（既有 provider 又带默认地址）永远匹配不上 →
  // 下拉显示"自定义"、保存时 provider 被改写成 openai、Key 的归属随之失效（2026-09-26 审查的 Critical）。
  const sameProvider = ASR_SERVICES.filter((item) => item.provider === provider);
  if (!sameProvider.length) return 'custom';
  if (sameProvider.length === 1) return sameProvider[0].id;
  const target = norm(baseUrl);
  const hit = sameProvider.find((item) => item.baseUrl && norm(item.baseUrl) === target);
  return hit ? hit.id : 'custom';
}

function asrServiceOptions(provider, baseUrl) {
  const current = asrServiceOf(provider, baseUrl);
  return ASR_SERVICES.map((item) => `<option value="${item.id}" ${item.id === current ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
}

// 语音转文字每小时上限：用户自己填（2026-09-26 要求从档位下拉改成输入框）。
// 与后端 config.asrMaxPerHour 同一口径：非正数/坏值按 12，范围收口到 1-200。
function normalizeAsrMax(current) {
  const n = Number(current);
  if (!Number.isFinite(n) || n <= 0) return 12;
  return Math.min(200, Math.max(1, Math.round(n)));
}

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名（群号） / 群 群号 / 私聊 号
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 */
function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return String(chatKey || '');
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 记忆"发现新人"门槛的取值口径（与「每小时最多转写」一致）：
 * 清空 / 非法输入保持原值；0 或负数回默认；其余按 [1, max] 收口 ——
 * 手输 9999 会存进配置并让"发现新人"事实上永久失效，右端必须夹住。
 */
function memThreshold(rawValue, current, max, fallback) {
  const raw = String(rawValue ?? '').trim();
  if (raw === '') return Number(current) || fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.round(n));
}

/*
 * 滑条换算（前端显示用）。
 *
 * ⚠️ 必须与 src/core/tier-slider.js 保持完全一致 —— 后端保存配置时会用它
 *    **重新权威换算**档位与概率，所以前端即使算错也不会影响实际行为；
 *    但两边不一致会让"界面显示的档位"和"实际生效的档位"对不上，造成困惑。
 *    ui/ 与 src/ 是两套模块作用域，那边导不进来，只能镜像一份。
 */
/** 概率取值（与后端 tier-slider.js 的 clampProbability 同一套规则）。 */
function clampProbabilityUI(value, fallback = 100) {
  // 与后端一致：先判"有没有值"，Number(null)/Number('') 都是 0，不能拿来当概率
  const missing = value === undefined || value === null || String(value).trim() === '';
  const n = missing ? NaN : Number(value);
  if (!Number.isFinite(n)) return Math.min(100, Math.max(0, Number(fallback) || 0));
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

/** 滑条值 = 概率；tier 只用来选读多少条与展示触发方式。 */
function sliderToTierUI(pos) {
  const probability = clampProbabilityUI(pos, 100);
  return {
    tier: probability <= 0 ? 1 : (probability >= 100 ? 4 : 3),
    randomPercent: probability
  };
}

/** 老四段式滑条位置 → 概率（与后端 legacySliderToProbability 同一套规则）。 */
function legacySliderToProbabilityUI(pos) {
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return 100;
  const p = Math.min(100, Math.max(0, raw));
  if (p <= 20) return 0;
  if (p >= 90) return 100;
  return Math.round(((p - 20) / 70) * 1000) / 10;
}

/**
 * 已保存配置 → 滑条位置。存的就是概率；
 * 老配置（四段式，没打 sliderMode 标记）要先按老口径换算 ——
 * 否则界面会把"老 1 档的位置 5"当成"5% 概率"显示并回写，用户一保存就被悄悄改掉。
 */
function sliderToTierUI_tierToSlider(st) {
  const rawPos = st?.contextSliderPos;
  // ⚠️ 不能用 Number(rawPos) 判有没有值：Number(null) === 0，会把"没设位置"当成"位置 0"
  const hasPos = rawPos !== undefined && rawPos !== null && String(rawPos).trim() !== '';
  const legacyMode = String(st?.sliderMode || '') !== 'probability';
  if (hasPos) {
    return legacyMode ? legacySliderToProbabilityUI(rawPos) : clampProbabilityUI(rawPos);
  }
  const t = Math.min(4, Math.max(1, Number(st?.contextTier) || 4));
  if (t >= 4) return 100;
  if (t <= 2) return 0;
  return clampProbabilityUI(st?.randomPercent, 0);
}

/** 分群表：老配置的值也要换算成概率（界面上显示的与保存的都按新语义）。 */
function groupSliderPosForUi(st) {
  const map = st?.groupSliderPos || {};
  if (String(st?.sliderMode || '') === 'probability') return map;
  const out = {};
  for (const [groupId, pos] of Object.entries(map)) out[groupId] = legacySliderToProbabilityUI(pos);
  return out;
}

/** 概率落在刻度条的哪一段（只影响高亮）。 */
function segOfProbability(value) {
  const p = clampProbabilityUI(value);
  if (p <= 0) return 1;
  if (p >= 100) return 4;
  return p < 50 ? 2 : 3;
}

/** 四个"读取条数"参数里哪些现在用得上：被 @ / 关键词那两条始终算数。 */
function paramActiveForProbability(value) {
  const p = clampProbabilityUI(value);
  return { at: true, keyword: true, random: p > 0 && p < 100, all: p >= 100 };
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const p = clampProbabilityUI(pos);
  let main;
  if (p <= 0) main = '<b>0%</b>：普通消息不回（标记已读、不调模型）；<b>被 @ 或命中关键词一定回</b>';
  else if (p >= 100) main = '<b>100% · 全响应</b>：任何消息都回';
  else main = `普通消息 <b>${p}%</b> 概率回（大约每 100 批接 ${p} 批）；<b>被 @ 或命中关键词一定回</b>`;
  // 档位管的是"它没在跟人对话时，要不要接这句话"。下面两条路不受档位限制，
  // 不写清楚就会被当成"档位调了没生效"。
  return main
    + '<br><span class="muted">档位只管群聊里"要不要搭话"：私聊被直接找时总会回；'
    + '对话模式是「参与者续接 / 完整生命周期」时，刚跟你说过话的人在活跃窗口内的消息也直接回（这两条不看概率）。</span>';
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

// 磁盘写入档位：绝大多数用户不该自己算毫秒和 SQLite 同步级别（Issue #45）。
// 值仍是 store.sessionPersistMs / store.sqliteSynchronous，配置文件照旧可手调。
const IO_PROFILES = Object.freeze({
  balanced: { persistMs: 10000, synchronous: 'FULL' },
  low: { persistMs: 30000, synchronous: 'NORMAL' },
  minimal: { persistMs: 60000, synchronous: 'NORMAL' }
});

/** 已存配置 → 档位；不在三档里就显示为自定义（保存时保持原值）。 */
function ioProfileOf(store = {}) {
  const ms = Number(store.sessionPersistMs ?? IO_PROFILES.balanced.persistMs);
  const sync = String(store.sqliteSynchronous || IO_PROFILES.balanced.synchronous).toUpperCase();
  for (const [key, profile] of Object.entries(IO_PROFILES)) {
    if (profile.persistMs === ms && profile.synchronous === sync) return key;
  }
  return 'custom';
}


export {
  IO_PROFILES, ioProfileOf,
  asrHostOf, asrServiceOf, asrServiceOptions, asrSlotOf, chatNameOf, clampInt, effectivePriceFor, fmtClock, fmtRate,
  fmtRemainingMs, fmtTime, fmtTok, fmtTokens, fmtWaitRemain, fmtYuan, formatChatTitle, formatElapsed,
  formatMinimalMarkdown, formatReleaseNotes, formatRevision, groupSliderPosForUi, hasOwnPrice, hostOfUrl, initialServiceNote,
  legacyServiceDeployed, matchPriceTable, memThreshold, mulOf, normalizeAsrMax, normalizeImageGenMax, normalizeStickerMax,
  normalizeStickerCollectMax,
  onebotIssueText, onebotStatusLineHtml, paramActiveForProbability, parseList, priceTxt, segOfProbability,
  serviceTileState, serviceUrl, sliderDesc, sliderToTierUI, sliderToTierUI_tierToSlider,
  uiServiceOfUrl, versionWithRevision
};