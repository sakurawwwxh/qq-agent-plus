// 「平台能力」设置分区（2026-10-07）：协议端 SnowLuma 接入的 QQ 平台能力开关。
// 口径与表情包/搜索/ASR 一致：开关关掉后，对应工具会被 orchestrator 从模型工具表里摘除、
// 提示词也不再教用法 —— 不只是"界面上隐藏"。个别项来自 send.*（正在输入），其余一对一映射
// config.platform.*；保存映射见 settings-save.js。
//
// 2026-10-07 第二批（用户："控制台设置可以详细一点"）：
//   ① 读 / 写拆开（"只让它看，不让它动手"要能单独配）；
//   ② 每个开关旁边列出它管的工具名 —— 从 /api/platform/gates 拉（**不在 ui 里再抄一份**，
//      抄一份就会在下次拆键时漏掉一半；拉失败只影响这行说明，不影响开关本身）；
//   ③ 写入闸门（贴表情/资料/备注/换头像/私聊文件）的上限可改、并显示当前用量；
//   ④ 按群覆盖（config.platform.perGroup）：某个群单独开/关某项，其余群跟随全局。
'use strict';

import { api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { state } from '../core/state.js';

// 门控键的显示顺序与标签（与 src/core/platform-gates.js 的键一一对应；
// 工具名从接口补，标签这边写死 —— 标签纯展示，键名错了下面那条锚点用例会红）。
const GATE_SECTIONS = [
  ['像群友一样的小动作', '在群里做的动作，读的写的各占一行', [
    ['reactionsWrite', '贴表情回应'],
    ['faceWrites', '发 QQ 系统表情（小黄脸）'],
    ['reactions', '看表情回应'],
    ['qqVoice', 'QQ 原生语音（群聊限定）'],
    ['profileWrites', '改个性签名 / 在线状态'],
    ['remarkWrites', '改好友 / 群备注'],
    ['avatarWrites', '换 QQ 头像'],
    ['nicknameWrites', '改 QQ 昵称 / 个性说明']
  ]],
  ['信息与素材', '群资料与素材，以及当前私聊的文本资料', [
    ['groupTools', '看群资料：简介 / 公告 / 荣誉'],
    ['groupWrites', '群签到 / 把消息设成群待办'],
    ['ocr', '服务端 OCR：读图上的文字'],
    ['groupFiles', '群文件：看目录 / 取下载直链'],
    ['groupFileSend', '群文件：发文件到群'],
    ['privateFileSend', '私聊文件：发送纯文本资料（不读本机文件或网址）'],
    ['albumRead', '群相册：看相册与照片'],
    ['albumWrites', '群相册：点赞 / 评论'],
    ['albumUpload', '群相册：把图传进相册']
  ]]
];

// 会话与呈现：不是工具门控（没有对应工具），但同属这一页 —— 渲染成同款行，不放进 GATE_SECTIONS
// （进那里会被当成门控键写进按群覆盖编辑器与保存映射）。
const BEHAVIOR_ROWS = [
  ['cfg-typing', '私聊发言前先亮「正在输入…」', '群聊里 QQ 没有输入状态，只对私聊生效'],
  ['cfg-platform-readreceipts', '处理完的消息在 QQ 里标已读', '开了之后你自己各端看不到未读小红点，所以默认关'],
  ['cfg-platform-forwardcards', '群日报等长内容用「聊天记录卡片」发送', '关掉＝回到一整段纯文本']
];

// 写入闸门：与 src/core/platform-gates.js 的 PLATFORM_QUOTA_DEFAULTS 一一对应
// （默认值只在这里做"输入框留空时的提示"，真正的默认值在服务端）。
const QUOTA_ROWS = [
  ['reactionsPerHour', '贴表情（每小时）', 10],
  ['albumWritesPerHour', '相册点赞 / 评论（每小时）', 5],
  ['profilePerDay', '签名 / 在线状态（每天）', 1],
  ['remarksPerDay', '备注（每天）', 1],
  ['avatarsPerWeek', '换头像（每周）', 1],
  ['privateFilesPerDay', '私聊文本文件（每天）', 10]
];

const gateCheckboxId = (key) => `cfg-platform-${key.toLowerCase()}`;
const ALL_GATE_KEYS = GATE_SECTIONS.flatMap(([, , rows]) => rows.map(([key]) => key));
// 门控键的标签（按群覆盖编辑器要按同一份标签渲染；渲染开关行与它共用）
const GATE_LABELS = new Map(GATE_SECTIONS.flatMap(([, , rows]) => rows.map(([key, label]) => [key, label])));

/**
 * 开关行：复选框 + 标签（默认关的挂一枚 chip）+ 工具 chip 占位（工具名由 hydrate 从接口补）。
 * 工具名单独一行做成 mono chip，不塞进标签括号里 —— 标签行要能一眼扫完。
 */
function gateRowHtml(key, label) {
  const id = gateCheckboxId(key);
  const extra = key === 'qqVoice' ? voiceSelectRowHtml()
    : key === 'privateFileSend' ? `<div class="plat-tools-empty" id="${id}-note">仅向当前私聊发送本轮文字，正文上限按下方设置（默认 64 KiB，硬上限 256 KiB），支持 TXT/MD/CSV/JSON；不读取本机资料或下载网址内容。投递结果未知时需人工核对，不自动重试。</div>
            <div class="plat-sub">
              <label for="cfg-platform-privatefilemaxkib">正文大小上限（KiB）</label>
              <input type="number" id="cfg-platform-privatefilemaxkib" min="1" max="256" step="1" value="${privateFileMaxKiBValue(state.config?.platform?.privateFileMaxKiB)}" aria-describedby="${id}-note" style="width:90px;min-width:0" />
            </div>` : '';
  const describedBy = key === 'privateFileSend' ? ` aria-describedby="${id}-note"` : '';
  return `        <div class="plat-row">
          <input type="checkbox" id="${id}"${describedBy} ${keyDefaultOn(key) ? 'checked' : ''} />
          <div class="plat-row-main">
            <label class="plat-label" for="${id}">${esc(label)}${gateDefaultOn(key) ? '' : ' <span class="chip warn">默认关</span>'}</label>
            <div class="plat-tools" data-gate-tools="${esc(key)}"><span class="plat-tools-empty">工具清单加载中…</span></div>
            ${extra}
          </div>
        </div>`;
}

/** 语音音色：跟在「QQ 原生语音」这一行的工具清单下面（音色是它的参数，不是独立能力）。 */
function voiceSelectRowHtml() {
  const voiceChar = String(state.config?.platform?.qqVoiceCharacter ?? '').trim();
  return `<div class="plat-sub">
              <label for="cfg-platform-voicechar">语音音色</label>
              <select class="plat-select" id="cfg-platform-voicechar" style="min-width:200px">
                <option value="">不固定（让它自己挑）</option>
                ${voiceChar ? `<option value="${esc(voiceChar)}" selected>${esc(voiceChar)}</option>` : ''}
              </select>
              <span class="hint muted" id="cfg-platform-voicechar-note" style="margin:0">正在拉取音色列表…</span>
            </div>`;
}

/** 行为行（正在输入 / 标已读 / 日报卡片）：同款外观，但没有工具 chip。 */
function behaviorRowHtml(id, label, note, checked) {
  return `        <div class="plat-row">
          <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
          <div class="plat-row-main">
            <label class="plat-label" for="${id}">${esc(label)}</label>
            <div class="plat-tools-empty">${esc(note)}</div>
          </div>
        </div>`;
}

// 默认取向：只用于"首次渲染时复选框是否勾上"。真正的默认值在服务端（config-legacy），
// 页面渲染拿的是已保存配置，这里只兜"配置里没有这个键"的老配置。
const DEFAULT_OFF_KEYS = new Set(['avatarWrites', 'nicknameWrites', 'albumUpload', 'privateFileSend']);
// 与服务端范围一致；真实 DOM 用例核对默认值、硬上限与保存值，后端仍独立执行硬限制。
function privateFileMaxKiBValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(256, Math.floor(value))) : 64;
}
/** 键的内置默认取向（"默认关"= 未显式 true 就不放行）。渲染与保存兜底共用。 */
function gateDefaultOn(key) {
  return !DEFAULT_OFF_KEYS.has(key);
}
function keyDefaultOn(key) {
  const saved = state.config?.platform?.[key];
  return typeof saved === 'boolean' ? saved : gateDefaultOn(key);
}

/** 「平台能力」分区。 */
function renderPlatformSection(c) {
  const p = c.platform || {};
  const quotas = p.quotas || {};
  // 选项 = 白名单 ∪ 已经存过覆盖的群 ∪ 草稿里改过的群：某个群被移出白名单后，
  // 它的覆盖还在 config 里，不在下拉里就会"看不见也清不掉"（2026-10-07 审计 P3）
  const savedOverridden = Object.keys(c.platform?.perGroup || {});
  const draftOverridden = Object.keys(state.platformPerGroupDraft || {});
  const allowGroups = (c.allow?.groups || []).map(String);
  const groups = [...new Set([...allowGroups, ...savedOverridden, ...draftOverridden])];
  const gateCard = ([title, note, rows]) => `
    <section class="plat-card">
      <div class="plat-card-head">
        <h3 class="plat-card-title">${esc(title)}</h3>
        <span class="plat-card-note">${esc(note)}</span>
      </div>
${rows.map(([key, label]) => gateRowHtml(key, label)).join('\n')}
    </section>`;
  return `
    ${GATE_SECTIONS.map(gateCard).join('\n')}
    <section class="plat-card">
      <div class="plat-card-head">
        <h3 class="plat-card-title">会话与呈现</h3>
        <span class="plat-card-note">和你对话时的观感，与工具无关</span>
      </div>
${BEHAVIOR_ROWS.map(([id, label, note]) => behaviorRowHtml(id, label, note,
    id === 'cfg-typing' ? state.config?.send?.typingIndicator !== false
      : id === 'cfg-platform-readreceipts' ? c.platform?.readReceipts === true
        : c.platform?.forwardCards !== false)).join('\n')}
    </section>

    <section class="plat-card">
      <div class="plat-card-head">
        <h3 class="plat-card-title">写入次数上限</h3>
        <span class="plat-card-note">防模型抽风的刹车：每项的默认值就是输入框里的数，改完保存即可</span>
      </div>
      <table class="plat-quota-table">
        <thead><tr><th>项目</th><th>上限</th><th>当前用量（滑动窗口）</th></tr></thead>
        <tbody>
${QUOTA_ROWS.map(([key, label, dflt]) => `          <tr>
            <td><label for="cfg-platform-quota-${esc(key)}">${esc(label)}</label></td>
            <td><input type="number" id="cfg-platform-quota-${esc(key)}" min="1" max="200" step="1" value="${esc(quotas[key] ?? dflt)}" /></td>
            <td><span class="plat-quota-used" data-quota-used="${esc(key)}">读取中…</span></td>
          </tr>`).join('\n')}
        </tbody>
      </table>
      <div class="hint" style="margin:2px 0 10px">留空或用 0 / 非法值 = 回到默认（这是刹车，不是"不限量"开关）；上限硬顶 200。</div>
    </section>

    <section class="plat-card">
      <div class="plat-card-head">
        <h3 class="plat-card-title">按群覆盖</h3>
        <span class="plat-card-note">可选：让某个群和全局不一样</span>
      </div>
      ${groups.length ? `
      <div class="plat-panel">
        <div class="plat-panel-head">
          <label for="pergroup-group">选择群</label>
          <select class="plat-select" id="pergroup-group" style="min-width:200px">${groups.map((g) => `<option value="${esc(g)}">${esc(g)}${allowGroups.includes(g) ? '' : '（已不在白名单）'}</option>`).join('')}</select>
          <button type="button" class="btn btn-small" id="pergroup-clear">清除本群覆盖</button>
          <span class="hint muted" id="pergroup-note" style="margin:0"></span>
        </div>
        <div class="plat-grid" id="pergroup-rows">${'<!-- 逐项三态选择由 hydrate / 切群时渲染 -->'}</div>
      </div>
      <div class="hint" style="margin:8px 0 10px">默认所有群都用上面的全局设置；这里只改选中的那个群，其余群照旧。选「跟随全局」= 不覆盖。</div>`
      : '<div class="hint" style="margin-bottom:10px">白名单里还没有群 —— 先在「聊天白名单」加群，再回来按群覆盖。</div>'}
    </section>

    <section class="plat-card">
      <div class="plat-card-head">
        <h3 class="plat-card-title">插件宿主（高级）</h3>
        <span class="plat-card-note">第三方插件进程的资源与网络边界</span>
      </div>
      <div class="field-row">
        <div class="field"><label for="cfg-plugin-memory">单个插件内存上限（MB，V8 堆）</label>
          <input type="number" id="cfg-plugin-memory" min="32" max="1024" value="${esc(c.plugins?.limits?.memoryMb ?? 128)}" /></div>
        <div class="field"><label for="cfg-plugin-calls">单个插件每分钟最多调用（次）</label>
          <input type="number" id="cfg-plugin-calls" min="10" max="1000" value="${esc(c.plugins?.limits?.callsPerMinute ?? 120)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="cfg-plugin-concurrency">单个插件并发调用上限</label>
          <input type="number" id="cfg-plugin-concurrency" min="1" max="32" value="${esc(c.plugins?.limits?.concurrency ?? 4)}" /></div>
        <div class="field"><label for="cfg-plugin-disk">插件数据磁盘上限（MB）</label>
          <input type="number" id="cfg-plugin-disk" min="8" max="4096" value="${esc(c.plugins?.limits?.diskMb ?? 256)}" /></div>
      </div>
      <div class="field"><label for="cfg-plugin-total-memory">全部插件总内存上限（MB，0=不限；Linux 生效）</label>
        <input type="number" id="cfg-plugin-total-memory" min="0" max="8192" value="${esc(c.plugins?.limits?.totalMemoryMb ?? 0)}" />
        <div class="hint">按运行中插件的 RSS 总和计算；达到上限后不再启动新插件。0 表示不设总预算，仍受上面的单插件内存上限约束。</div></div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-plugin-netiso" ${c.plugins?.networkIsolation !== false ? 'checked' : ''} />
        <label for="cfg-plugin-netiso">本机支持时，把插件放进无网络命名空间（联网只能走宿主代理）</label></div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-plugin-requirenetiso" ${c.plugins?.requireNetworkIsolation === true ? 'checked' : ''} />
        <label for="cfg-plugin-requirenetiso">要求网络隔离，做不到就拒绝加载插件</label></div>
      <div class="hint">内存上限是 V8 堆上限，不是 RSS；调用上限是每分钟工具调用次数。两项都只影响插件进程，不影响主程序。
        Windows / macOS 没有网络命名空间，打开「要求网络隔离」等于禁用全部插件。
        更严格的权限隔离（<code>plugins.requireIsolation</code>）保持配置默认的 fail-closed，不在界面开放关闭。</div>
    </section>

    <div class="hint" style="margin-top:2px">
      这些能力来自协议端 SnowLuma。关掉的项不只是"不显示"：对应工具会从模型的工具表里摘除，
      模型不会再调用它们，也不会在提示词里看到用法。<br>
      协议端版本决定能力是否完整（低于 1.14.20 时表情包在 QQ 里会显示成图片）——
      在「OneBot」页可以看当前版本并一键更新。
    </div>`;
}

// ── 按群覆盖编辑器 ──
// 草稿挂在 state（保存时 settings-save.js 读它）：所有群的改动先落在草稿里，
// 切群只是换渲染的数据源，切来切去不会丢；点保存才 POST。
function perGroupDraft() {
  if (!state.platformPerGroupDraft || typeof state.platformPerGroupDraft !== 'object') {
    state.platformPerGroupDraft = structuredClone(state.config?.platform?.perGroup || {});
  }
  return state.platformPerGroupDraft;
}

function currentPerGroupId() {
  return String(document.getElementById('pergroup-group')?.value || '');
}

function renderPerGroupRows() {
  const box = document.getElementById('pergroup-rows');
  if (!box) return;
  const gid = currentPerGroupId();
  const draft = perGroupDraft();
  const overrides = (gid && draft[gid]) || {};
  // 注意：外层 map 返回的是数组 —— 必须 flat() 再 join，否则内层数组会被
  // Array#join 用逗号连接，页面上每行之间多出一个孤零零的 ","（真机 2026-10-07 截图发现）。
  // 两列网格：15 项排成一屏能扫完的长度（单列要滚很久，真机反馈"好丑"的成因之一）。
  // 标签取 GATE_LABELS（与开关行同一份），不用再各写一遍。
  const rowOf = ([key]) => {
    if (key === 'privateFileSend') return ''; // 只作用于私聊，没有按群覆盖。
    // 三态：'' 跟随全局 / 'on' 本群开 / 'off' 本群关（草稿里存的是布尔值，这里换算成下拉值）
    const cur = overrides[key] === undefined ? '' : (overrides[key] ? 'on' : 'off');
    const sel = (v, text) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${text}</option>`;
    return `          <div class="plat-grid-row">
            <label for="pergroup-${esc(key)}">${esc(GATE_LABELS.get(key) || key)}</label>
            <select class="plat-select" id="pergroup-${esc(key)}" data-pergroup-key="${esc(key)}">
              ${sel('', '跟随全局')}${sel('on', '本群：开')}${sel('off', '本群：关')}
            </select>
          </div>`;
  };
  box.innerHTML = GATE_SECTIONS.map(([, , rows]) => rows.map(rowOf)).flat().join('\n');
  updatePerGroupNote();
  for (const el of box.querySelectorAll('[data-pergroup-key]')) {
    el.addEventListener('change', () => {
      const key = el.dataset.pergroupKey;
      const g = currentPerGroupId();
      if (!g) return;
      const next = { ...(draft[g] || {}) };
      if (el.value === '') delete next[key];
      else next[key] = el.value === 'on';
      if (Object.keys(next).length) draft[g] = next;
      else delete draft[g];
      // 只刷新提示行：这里整块重建会让刚操作的下拉失去焦点，键盘连续改很不顺手
      // （2026-10-07 审计 P3）。下拉自己的值本来就是对的，不需要重画。
      updatePerGroupNote();
    });
  }
}

/** 只刷新"本群已覆盖 N 项"那行提示（改一项时用，避免整块重建丢焦点）。 */
function updatePerGroupNote() {
  const gid = currentPerGroupId();
  const overrides = (gid && perGroupDraft()[gid]) || {};
  const n = Object.keys(overrides).length;
  const note = document.getElementById('pergroup-note');
  if (!note) return;
  // 用中文标签而不是配置键：这行文案是给人看的，"albumWrites=关" 还得回去对页面
  const list = Object.entries(overrides).map(([k, v]) => `${GATE_LABELS.get(k) || k} → ${v ? '开' : '关'}`);
  note.textContent = n ? `本群已覆盖 ${n} 项：${list.join('、')}` : '本群还没覆盖任何项（全部跟随全局）';
}

function bindPerGroup() {
  const sel = document.getElementById('pergroup-group');
  const clear = document.getElementById('pergroup-clear');
  if (sel) sel.addEventListener('change', () => renderPerGroupRows());
  if (clear) clear.addEventListener('click', () => {
    const g = currentPerGroupId();
    const draft = perGroupDraft();
    if (g) delete draft[g];
    renderPerGroupRows();
  });
  renderPerGroupRows();
}

/**
 * 「语音音色」下拉的数据补全：目录只有协议端知道（按群返回），所以渲染时先只有
 * 「不固定」+ 已保存的值，这里再异步拉列表换成按分类分组的完整目录。
 * 拉取失败不清空已有选择 —— 页面照常能保存。
 */
async function hydratePlatformVoiceSelect() {
  const sel = document.getElementById('cfg-platform-voicechar');
  if (!sel) return;   // 不在这一页
  const note = document.getElementById('cfg-platform-voicechar-note');
  try {
    const data = await api('/api/onebot/ai-characters');
    const chars = Array.isArray(data?.characters) ? data.characters : [];
    const groups = new Map();
    for (const c of chars) {
      const cat = String(c?.category || '其它');
      if (!groups.has(cat)) groups.set(cat, []);
      const list = groups.get(cat);
      // 同一个音色会出现在多个分类里（协议端就是这么分的）：分类内部去重
      if (!list.some((x) => x.characterId === c.characterId)) list.push(c);
    }
    const saved = String(sel.value || '');
    sel.innerHTML = `<option value="">不固定（让它自己挑）</option>`
      + [...groups.entries()].map(([cat, list]) =>
        `<optgroup label="${esc(cat)}">${list.map((c) =>
          `<option value="${esc(c.characterId)}">${esc(c.name || c.characterId)}</option>`).join('')}</optgroup>`).join('');
    if (saved && !chars.some((c) => c.characterId === saved)) {
      // 已保存的音色不在目录里（协议端目录变了/是手改的）也要保留，否则一打开页面就把它抹了
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(saved)}">${esc(saved)}（已不在目录里）</option>`);
    }
    sel.value = saved;
    if (note) note.textContent = chars.length ? `共 ${chars.length} 个音色（来自群 ${data.groupId}）` : '协议端没返回任何音色';
  } catch (error) {
    if (note) note.textContent = `没拉到音色列表（${error?.message ?? error}）—— 当前显示的是已保存的音色，仍可保存`;
  }
}

/**
 * 工具清单 + 配额用量的补全（都在「平台能力」页；不在这一页时各自 no-op）。
 * 工具清单来自 /api/platform/gates（服务端的键→工具映射，唯一一份）。
 */
async function hydratePlatformGates() {
  const slots = [...document.querySelectorAll('[data-gate-tools]')];
  const quotaSlots = [...document.querySelectorAll('[data-quota-used]')];
  if (!slots.length && !quotaSlots.length) return;   // 不在这一页
  // 编辑器是同步渲染的；坏了只该"这一块没出来"，不该把整页设置跟着炸掉
  try { bindPerGroup(); } catch (error) { console.warn('[platform] 按群覆盖编辑器渲染失败：', error); }
  // 两个请求各拉各的：一个失败不影响另一个
  if (slots.length) {
    api('/api/platform/gates').then((data) => {
      const byKey = new Map((data?.gates || []).map((g) => [g.key, g]));
      // 200 但没数据 ≠ 这项没有工具：区分两种文案，别把"没拉到"说成"确无工具"
      const loaded = Array.isArray(data?.gates) && data.gates.length > 0;
      for (const el of slots) {
        const info = byKey.get(el.dataset.gateTools);
        const tools = info?.tools || [];
        el.innerHTML = tools.length
          ? tools.map((name) => `<span class="plat-tool">${esc(name)}</span>`).join('')
          : `<span class="plat-tools-empty">${loaded ? '这项没有对应工具' : '工具清单没拉到（刷新重试）'}</span>`;
      }
    }).catch(() => {
      for (const el of slots) el.innerHTML = '<span class="plat-tools-empty">工具清单没拉到（刷新重试）</span>';
    });
  }
  if (quotaSlots.length) {
    api('/api/platform/quota-usage').then((data) => {
      // 接口分组用的是简称（reactions/profile/...），每一项里带规范 key（reactionsPerHour/…）；
      // 按 item.key 建索引 —— 直接用对象键会一个都对不上（真机 2026-10-07 验证时踩到）。
      const byKey = new Map(Object.values(data?.quotas || {}).map((info) => [info?.key, info]));
      for (const el of quotaSlots) {
        const info = byKey.get(el.dataset.quotaUsed);
        if (!info) { el.textContent = ''; continue; }
        const per = info.windowMs <= 3600_000 ? '本小时'
          : info.windowMs <= 24 * 3600_000 ? '今日'
            : `近 ${Math.round(info.windowMs / 86400_000)} 天`;
        const detail = (info.chats || []).slice(0, 2)
          .map((c) => `${String(c.chatKey).replace(/^group:/, '群')}x${c.count}`).join(' ');
        el.textContent = `${info.used} / ${info.limit}${detail ? `（${per}，${detail}）` : `（${per}）`}`;
        // 输入框回填服务端的**生效上限**：被夹过的值（手填 999 → 存 200）与
        // "配置里没这项、按默认走"两种情况都在这里显示成真实生效的数字。
        const input = document.getElementById(`cfg-platform-quota-${el.dataset.quotaUsed}`);
        if (input) input.value = String(info.limit);
      }
    }).catch(() => {
      for (const el of quotaSlots) el.textContent = '用量没读到';
    });
  }
}

export {
  ALL_GATE_KEYS, QUOTA_ROWS, gateCheckboxId, gateDefaultOn, hydratePlatformGates,
  hydratePlatformVoiceSelect, renderPlatformSection, privateFileMaxKiBValue
};
