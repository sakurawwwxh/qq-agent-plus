// 设置 → 见闻（生活层）：开关、觅食参数、候选队列与手动操作。
// 渲染函数由 settings.js 的分区表调用；按钮走事件委托，状态单独拉 /api/life-feed/status。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { askForConfirmation } from '../core/dom-util.js';
import { renderSessionPicker } from '../core/session-picker.js';

// render-test 的 vm 沙箱没有 queueMicrotask（浏览器与 happy-dom 有）：统一走这条兜底。
const defer = (fn) => (typeof queueMicrotask === 'function' ? queueMicrotask(fn) : Promise.resolve().then(fn));

function fmtTime(value) {
  const ts = Number(value) || 0;
  return ts > 0 ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function fmtDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const min = Math.floor(total / 60);
  return min > 0 ? `${min} 分钟` : `${total} 秒`;
}

function fmtPlay(count) {
  const value = Number(count) || 0;
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  return String(value);
}

function sourceLabel(source) {
  const value = String(source || '');
  if (value.startsWith('plugin:')) return `插件 · ${value.slice('plugin:'.length)}`;
  if (value === 'rss') return 'RSS';
  if (value === 'bilibili' || !value) return 'B站';
  return value;
}

function clip(text, max = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// 配置文件里可能存裸群号（手写 config.json / 旧版本），群清单只认 group:<id>。
// 不归一化的话这些行会显示成"不在当前群列表"的未勾选项，保存一次就把白名单清空。
function groupKeys(list) {
  return (Array.isArray(list) ? list : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean)
    .map((id) => (id.startsWith('group:') || !/^\d+$/.test(id) ? id : `group:${id}`));
}

function candidateMeta(item) {
  const parts = [];
  if (item.up) parts.push(`UP ${item.up}`);
  if (Number(item.play) > 0) parts.push(`播放 ${fmtPlay(item.play)}`);
  if (Number(item.duration) > 0) parts.push(fmtDuration(item.duration));
  return parts.join(' · ');
}

function candidateCard(item) {
  const source = String(item.source || '');
  const badgeClass = source.startsWith('plugin:')
    ? 'feed-badge--plugin'
    : (source === 'rss' ? 'feed-badge--rss' : 'feed-badge--bilibili');
  const meta = candidateMeta(item);
  const desc = clip(item.desc);
  const tags = (Array.isArray(item.tags) ? item.tags : [])
    .map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 4);
  const score = Number(item.score) || 0;
  return `
      <article class="feed-card" data-lifefeed-row="${esc(item.id)}">
        <a class="feed-card-cover" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">
          ${item.cover
            ? `<img src="${esc(item.cover)}" alt="" loading="lazy" />`
            : '<span class="feed-card-cover-empty">无封面</span>'}
        </a>
        <div class="feed-card-body">
          <div class="feed-card-badges">
            <span class="feed-badge ${badgeClass}">${esc(sourceLabel(source))}</span>
            ${item.offeredAt ? '<span class="feed-badge feed-badge--muted">已领取</span>' : ''}
            ${score > 0 ? `<span class="feed-card-score" title="候选评分">评分 ${score}</span>` : ''}
          </div>
          <a class="feed-card-title" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
          ${meta ? `<div class="feed-card-meta">${esc(meta)}</div>` : ''}
          ${desc ? `<p class="feed-card-desc">${esc(desc)}</p>` : ''}
          ${tags.length ? `<div class="feed-card-tags">${tags.map((tag) => `<span class="feed-tag">${esc(tag)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="feed-card-actions">
          <button type="button" class="btn btn-small" data-lifefeed-share="${esc(item.id)}">分享</button>
          <button type="button" class="btn btn-small" data-lifefeed-more="${esc(item.id)}">多来点类似</button>
          <button type="button" class="btn btn-small" data-lifefeed-dismiss="${esc(item.id)}">丢弃</button>
        </div>
      </article>`;
}

function setResult(text, error = false) {
  const node = $('#lifefeed-action-result');
  if (!node) return;
  node.textContent = text;
  node.style.color = error ? 'var(--danger, #c0392b)' : '';
}

async function loadStatus() {
  const box = $('#lifefeed-status');
  if (!box) return;
  try {
    const data = await api('/api/life-feed/status');
    const limits = data?.limits || {};
    for (const [selector, key] of [
      ['#cfg-lifefeed-interval', 'forageIntervalMinutes'],
      ['#cfg-lifefeed-offers', 'maxOffersPerDay'],
      ['#cfg-lifefeed-max-per-forage', 'maxPerForage'],
      ['#cfg-lifefeed-max-candidates', 'maxCandidates'],
      ['#cfg-lifefeed-min-duration', 'minDurationSec'],
      ['#cfg-lifefeed-max-duration', 'maxDurationSec']
    ]) {
      const node = $(selector);
      const bound = limits[key];
      if (!node || !bound) continue;
      node.min = String(bound.min);
      node.max = String(bound.max);
    }
    box.textContent = data.enabled
      ? `已开启 · 候选 ${data.candidateCount} 条 · 今日分享 ${data.todayShares ?? 0}/${data.maxOffersPerDay}`
        + ` · 领取 ${data.todayPicks ?? data.todayOffers ?? 0}/${data.maxPicksPerDay ?? 10}`
        + ` · 分享模式 ${data.shareMode === 'manual' ? '仅手动' : '自动'}`
        + `${data.todayManualOffers ? ` · 手动 ${data.todayManualOffers}` : ''}`
        + ` · 上次觅食 ${fmtTime(data.lastForageAt)} · 下次 ${fmtTime(data.nextForageAt)}`
        + (data.lastShare ? ` · 最近分享 ${data.lastShare.action === 'shared' ? '已发送' : '排队中'}` : '')
        + (data.shareStats?.['7d'] ? ` · 近7天分享 ${data.shareStats['7d'].shared}/跳过 ${data.shareStats['7d'].skipped}` : '')
        + (data.lastError ? ` · 上次错误：${data.lastError}` : '')
      : '未开启（保存开关后才会创建状态与定时器）';
    const list = $('#lifefeed-candidates');
    if (!list) return;
    const rows = Array.isArray(data.candidates) ? data.candidates : [];
    list.innerHTML = rows.length
      ? rows.map(candidateCard).join('')
      : '<div class="hint">队列是空的：开启后等一次觅食，或点「立刻觅食」。</div>';
  } catch (error) {
    box.textContent = `读取失败：${error?.message || error}`;
  }
}

async function onAction(event) {
  const forage = event.target?.closest?.('#lifefeed-forage');
  const refresh = event.target?.closest?.('#lifefeed-refresh');
  const clear = event.target?.closest?.('#lifefeed-clear');
  const share = event.target?.closest?.('[data-lifefeed-share]');
  const more = event.target?.closest?.('[data-lifefeed-more]');
  const dismiss = event.target?.closest?.('[data-lifefeed-dismiss]');

  if (refresh) {
    await loadStatus();
    return;
  }
  if (clear) {
    if (!(await askForConfirmation('清空全部候选？已分享记录、去重记录和反馈权重都会保留。'))) return;
    clear.disabled = true;
    try {
      const result = await api('/api/life-feed/clear', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      setResult(`已清空 ${result.removed ?? 0} 条候选`);
      await loadStatus();
    } catch (error) {
      setResult(`清空失败：${error?.message || error}`, true);
    } finally {
      clear.disabled = false;
    }
    return;
  }
  if (forage) {
    if (!(await askForConfirmation('现在去 B 站觅食一次？会发起外部请求。'))) return;
    forage.disabled = true;
    setResult('正在觅食…');
    try {
      const result = await api('/api/life-feed/forage', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      setResult(`觅食完成：新增 ${result.added ?? 0} 条，候选 ${result.candidates ?? 0} 条`, result.ok !== true);
    } catch (error) {
      setResult(`觅食失败：${error?.message || error}`, true);
    } finally {
      forage.disabled = false;
      await loadStatus();
    }
    return;
  }
  if (more) {
    try {
      await api('/api/life-feed/more', {
        method: 'POST', body: JSON.stringify({ bvid: more.dataset.lifefeedMore })
      });
      setResult('已记下：以后多找类似的');
      await loadStatus();
    } catch (error) {
      setResult(`记录失败：${error?.message || error}`, true);
    }
    return;
  }
  if (dismiss) {
    try {
      await api('/api/life-feed/dismiss', {
        method: 'POST', body: JSON.stringify({ bvid: dismiss.dataset.lifefeedDismiss })
      });
      setResult('已丢弃这条候选');
      await loadStatus();
    } catch (error) {
      setResult(`丢弃失败：${error?.message || error}`, true);
    }
    return;
  }
  if (share) {
    const manualGroup = String($('#cfg-lifefeed-chat-manual')?.value || '').trim();
    if (manualGroup && !/^\d+$/.test(manualGroup)) {
      setResult('这里只能填群号（纯数字）；要分享到私聊请清空后从下拉框选', true);
      return;
    }
    // 手填优先：下拉框只要有一个群就恒非空，若以下拉框优先，"或填群号"永远不生效。
    const chatKey = manualGroup
      ? `group:${manualGroup}`
      : String($('#cfg-lifefeed-chat')?.value || '');
    if (!chatKey) {
      setResult('没有可分享的会话：先选一个群/私聊，或在下方填群号', true);
      return;
    }
    if (!(await askForConfirmation(`让机器人现在在 ${chatKeyLabel(chatKey)} 分享这条见闻？会走一次主动发言。`))) return;
    share.disabled = true;
    try {
      await api('/api/life-feed/share', {
        method: 'POST',
        body: JSON.stringify({ confirm: true, chatKey, bvid: share.dataset.lifefeedShare })
      });
      setResult('已交给主动发言链路（排队中）；发送成功后可刷新查看最近分享状态');
      await loadStatus();
    } catch (error) {
      setResult(`分享失败：${error?.message || error}`, true);
    } finally {
      share.disabled = false;
    }
  }
}

function chatKeyLabel(chatKey) {
  const key = String(chatKey || '');
  if (key.startsWith('private:')) return `私聊 ${key.slice('private:'.length)}`;
  if (key.startsWith('group:')) return `群 ${key.slice('group:'.length)}`;
  return key;
}

// 手动分享下拉：从聊天白名单建初稿（群 + 私聊），好友/群名稍后异步补上。
// 只列白名单里的会话 —— 分享走 requestManualWake，不在白名单里的会话本来也唤不醒。
function manualChatOptions(c) {
  const groups = Array.isArray(c.allow?.groups) ? c.allow.groups.map(String) : [];
  const privates = Array.isArray(c.allow?.private) ? c.allow.private.map(String) : [];
  const groupOptions = groups.map((id) => `<option value="group:${esc(id)}">群 ${esc(id)}</option>`).join('');
  const privateOptions = privates.map((id) => `<option value="private:${esc(id)}">私聊 ${esc(id)}</option>`).join('');
  if (!groupOptions && !privateOptions) return '<option value="">（聊天白名单为空）</option>';
  return `${groupOptions ? `<optgroup label="群">${groupOptions}</optgroup>` : ''}`
    + `${privateOptions ? `<optgroup label="私聊">${privateOptions}</optgroup>` : ''}`;
}

// 把下拉框里的裸号码换成「群号 · 群名」/「QQ · 昵称」。协议端不在线就保持原样。
async function hydrateShareChatNames() {
  const select = document.getElementById('cfg-lifefeed-chat');
  if (!select) return;
  const [groupResult, friendResult] = await Promise.allSettled([
    api('/api/onebot/groups'),
    api('/api/onebot/friends')
  ]);
  const names = new Map();
  if (groupResult.status === 'fulfilled') {
    for (const group of groupResult.value?.groups || []) names.set(`group:${group.id}`, group.name);
  }
  if (friendResult.status === 'fulfilled') {
    for (const friend of friendResult.value?.friends || []) names.set(`private:${friend.id}`, friend.name);
  }
  for (const option of select.querySelectorAll('option')) {
    const key = String(option.value || '');
    if (!key) continue;
    const name = String(names.get(key) || '').trim();
    if (name) option.textContent = `${chatKeyLabel(key)} · ${name}`;
  }
}

function renderLifeFeedSection(c) {
  const cfg = c.lifeFeed || {};
  const selectedGroups = groupKeys(cfg.groups);
  const selectedShareGroups = groupKeys(cfg.shareGroups);
  const chatOptions = manualChatOptions(c);

  defer(() => {
    const root = document.getElementById('settings-lifefeed');
    if (!root) return;
    if (root.dataset.bound !== '1') {
      root.dataset.bound = '1';
      root.addEventListener('click', onAction);
    }
    // 兴趣来源与分享目标现在都支持群 + 私聊：页面里只留一行摘要，选择在弹窗里完成，
    // 群/好友上百个也不会把设置页撑长（旧的并排清单会一边高一边空）。
    void renderSessionPicker('cfg-lifefeed-groups-box', selectedGroups, { title: '从哪些会话提炼兴趣' });
    void renderSessionPicker('cfg-lifefeed-sharegroups-box', selectedShareGroups, { title: '允许自动分享到哪些会话' });
    void hydrateShareChatNames();
    void loadStatus();
  });

  return `
    <div id="settings-lifefeed">
      <h3>生活层 · 见闻</h3>
      <p class="hint">机器人每隔几小时自己去 B 站看看，把候选存进队列；主动发言时可以用自己的语气分享到群或私聊。
        默认关闭。分享复用现有发送链路：安静时段、暂停、观察模式、白名单与限速全部生效。</p>

      <div class="lifefeed-section">
        <div class="lifefeed-section-title">运行与额度</div>
        <div class="lifefeed-grid">
          <div class="field"><label>运行开关</label>
            <div class="lifefeed-switch-line"><label class="checkbox-row"><input type="checkbox" id="cfg-lifefeed-enabled"${cfg.enabled === true ? ' checked' : ''} /> <span>启用生活层</span></label></div>
          </div>
          <div class="field"><label>觅食间隔（分钟）</label>
            <input type="number" id="cfg-lifefeed-interval" value="${esc(cfg.forageIntervalMinutes ?? 360)}" />
          </div>
          <div class="field"><label>每天最多分享</label>
            <input type="number" id="cfg-lifefeed-offers" value="${esc(cfg.maxOffersPerDay ?? 2)}" />
          </div>
          <div class="field"><label>每天最多领取</label>
            <input type="number" id="cfg-lifefeed-picks" value="${esc(cfg.maxPicksPerDay ?? 10)}" />
          </div>
        </div>
      </div>

      <div class="lifefeed-section">
        <div class="lifefeed-section-title">来源与分享</div>
        <div class="lifefeed-grid lifefeed-grid--2">
          <div class="field"><label>内容来源</label>
            <div class="lifefeed-toggles">
              ${[['bilibili', 'B站'], ['plugin', '插件'], ['rss', 'RSS']].map(([id, label]) =>
                `<label class="checkbox-row"><input type="checkbox" id="cfg-lifefeed-src-${id}"${(cfg.sources || ['bilibili', 'plugin']).includes(id) ? ' checked' : ''} /> <span>${label}</span></label>`).join('')}
            </div>
          </div>
          <div class="field"><label>分享模式</label>
            <select id="cfg-lifefeed-sharemode">
              <option value="auto" ${cfg.shareMode !== 'manual' ? 'selected' : ''}>自动（主动轮次自行决定）</option>
              <option value="manual" ${cfg.shareMode === 'manual' ? 'selected' : ''}>仅手动（控制台点分享）</option>
            </select>
          </div>
          <div class="field span-full"><label>RSS / Atom 地址（逗号或换行分隔，最多 10 个）</label>
            <input type="text" id="cfg-lifefeed-rss-urls" value="${esc((cfg.rssUrls || []).join(', '))}" placeholder="https://example.com/feed.xml" />
          </div>
        </div>
      </div>

      <div class="lifefeed-section">
        <div class="lifefeed-section-title">觅食与时长</div>
        <div class="lifefeed-grid">
          <div class="field"><label>单次觅食上限</label>
            <input type="number" id="cfg-lifefeed-max-per-forage" value="${esc(cfg.maxPerForage ?? 30)}" />
          </div>
          <div class="field"><label>候选队列上限</label>
            <input type="number" id="cfg-lifefeed-max-candidates" value="${esc(cfg.maxCandidates ?? 200)}" />
          </div>
          <div class="field"><label>最短时长（秒）</label>
            <input type="number" id="cfg-lifefeed-min-duration" value="${esc(cfg.minDurationSec ?? 60)}" />
          </div>
          <div class="field"><label>最长时长（秒）</label>
            <input type="number" id="cfg-lifefeed-max-duration" value="${esc(cfg.maxDurationSec ?? 3600)}" />
          </div>
        </div>
      </div>

      <div class="lifefeed-section">
        <div class="lifefeed-section-title">关键词</div>
        <div class="lifefeed-grid lifefeed-grid--2">
          <div class="field"><label>额外关键词（逗号分隔）</label>
            <input type="text" id="cfg-lifefeed-extra" value="${esc((cfg.extraKeywords || []).join(', '))}" placeholder="例如：独立游戏, 深海" />
          </div>
          <div class="field"><label>排除关键词</label>
            <input type="text" id="cfg-lifefeed-exclude" value="${esc((cfg.excludeKeywords || []).join(', '))}" placeholder="例如：广告, 营销" />
          </div>
        </div>
      </div>

      <div class="lifefeed-section">
        <div class="lifefeed-section-title">分享范围</div>
        <div class="lifefeed-grid lifefeed-grid--2">
          <div class="field"><label>从哪些会话提炼兴趣（群 / 私聊；不勾 = 沿用聊天白名单）</label>
            <div id="cfg-lifefeed-groups-box"></div>
          </div>
          <div class="field"><label>允许自动分享到哪些会话（群 / 私聊；不勾 = 沿用聊天白名单）</label>
            <div id="cfg-lifefeed-sharegroups-box"></div>
          </div>
        </div>
      </div>

      <div class="lifefeed-section">
        <div class="lifefeed-section-title">手动操作</div>
        <div class="lifefeed-grid lifefeed-grid--2">
          <div class="field"><label>手动分享到</label>
            <select id="cfg-lifefeed-chat">${chatOptions}</select>
          </div>
          <div class="field"><label>或填群号（优先于下拉框）</label>
            <input type="text" id="cfg-lifefeed-chat-manual" placeholder="例如 123456789" />
          </div>
        </div>
        <div class="asset-head-actions lifefeed-actions">
          <button type="button" class="btn btn-small" id="lifefeed-forage">立刻觅食</button>
          <button type="button" class="btn btn-small" id="lifefeed-clear">清空候选</button>
          <button type="button" class="btn btn-small" id="lifefeed-refresh">刷新状态</button>
          <span class="hint" id="lifefeed-action-result"></span>
        </div>
      </div>

      <div class="lifefeed-section">
        <div class="lifefeed-section-title">候选队列</div>
        <div class="hint" id="lifefeed-status">正在读取…</div>
        <div id="lifefeed-candidates"></div>
      </div>
    </div>`;
}

export { renderLifeFeedSection, candidateCard, groupKeys };
