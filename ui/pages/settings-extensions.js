// 平台扩展设置：MCP / 轻量知识库 / 群管理。
// 这些开关与 server 列表都是管理员级配置；保存走 settings-save.js 的统一 saveConfig。

import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';

function mcpServerRowHtml(server = {}, { open = false } = {}) {
  const id = esc(server.id || '');
  const args = esc(JSON.stringify(Array.isArray(server.args) ? server.args : []));
  const env = esc(JSON.stringify(server.env && typeof server.env === 'object' ? server.env : {}));
  const mounting = String(server.toolMounting || 'direct');
  const sandbox = server.sandbox && typeof server.sandbox === 'object' ? server.sandbox : {};
  const sandboxMode = ['off', 'auto', 'required'].includes(String(sandbox.mode || ''))
    ? String(sandbox.mode)
    : (server.networkIsolation === true || server.permissionIsolation === true ? 'required' : 'off');
  const sandboxNetwork = ['none', 'loopback', 'host'].includes(String(sandbox.network || ''))
    ? String(sandbox.network)
    : (server.networkIsolation === true ? 'none' : 'host');
  return `
    <details class="mcp-server" data-id="${id}" ${open ? 'open' : ''}>
      <summary>
        <span class="mcp-server-dot"></span>
        <span class="mcp-server-name">${id || '新 server'}</span>
        <span class="mcp-server-cmd">${esc(server.command || '未填命令')}</span>
        <span class="mcp-server-state" data-mcp-state="${id}">未保存</span>
      </summary>
      <div class="mcp-server-body">
        <div class="field-row">
          <div class="field"><label>ID</label><input class="mcp-id" type="text" value="${id}" placeholder="files" /></div>
          <div class="field"><label>命令</label><input class="mcp-command" type="text" value="${esc(server.command || '')}" placeholder="npx" /></div>
          <div class="field"><label>超时（毫秒）</label><input class="mcp-timeout" type="number" min="1000" max="300000" value="${esc(server.timeoutMs ?? 30000)}" /></div>
          <div class="field"><label>每分钟上限</label><input class="mcp-maxcalls" type="number" min="1" max="600" value="${esc(server.maxCallsPerMinute ?? 30)}" /></div>
        </div>
        <div class="field"><label>参数（JSON 数组）</label><input class="mcp-args" type="text" value="${args}" placeholder='["-y","@modelcontextprotocol/server-filesystem","/data"]' /></div>
        <div class="field"><label>工作目录（可选）</label><input class="mcp-cwd" type="text" value="${esc(server.cwd || '')}" placeholder="/srv/workspace" /></div>
        <div class="field"><label>环境变量（JSON 对象，可留空）</label><input class="mcp-env" type="text" value="${env}" placeholder='{"TOKEN":"..."}' /></div>
        <div class="field"><label>额外可写目录（JSON 数组，可留空）</label><input class="mcp-writable-paths" type="text" value="${esc(JSON.stringify(Array.isArray(sandbox.writablePaths) ? sandbox.writablePaths : []))}" placeholder='["/srv/workspace"]' />
          <div class="hint">仅 bwrap 沙箱生效；不能与数据目录重叠，根目录会被拒绝。</div></div>
        <div class="field-row">
          <div class="field"><label><input class="mcp-network-isolation" type="checkbox" ${server.networkIsolation === true ? 'checked' : ''} /> 网络隔离（禁网）</label></div>
          <div class="field"><label><input class="mcp-permission-isolation" type="checkbox" ${server.permissionIsolation === true ? 'checked' : ''} /> Node 权限隔离（只读入口目录）</label></div>
          <div class="field"><label>堆上限 MB（隔离时生效）</label><input class="mcp-memory" type="number" min="0" max="4096" value="${esc(server.memoryMb ?? 0)}" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>沙箱模式</label><select class="mcp-sandbox-mode">
            <option value="off" ${sandboxMode === 'off' ? 'selected' : ''}>off（不沙箱）</option>
            <option value="auto" ${sandboxMode === 'auto' ? 'selected' : ''}>auto（能用就用）</option>
            <option value="required" ${sandboxMode === 'required' ? 'selected' : ''}>required（必须隔离）</option>
          </select></div>
          <div class="field"><label>网络策略</label><select class="mcp-sandbox-network">
            <option value="none" ${sandboxNetwork === 'none' ? 'selected' : ''}>none（禁网）</option>
            <option value="loopback" ${sandboxNetwork === 'loopback' ? 'selected' : ''}>loopback（仅 docker）</option>
            <option value="host" ${sandboxNetwork === 'host' ? 'selected' : ''}>host（不隔离）</option>
          </select></div>
          <div class="field"><label><input class="mcp-allow-unsandboxed" type="checkbox" ${server.allowUnsandboxed === true ? 'checked' : ''} /> 允许未沙箱运行（显式信任）</label></div>
        </div>
        <div class="field-row">
          <div class="field"><label>挂载方式</label><select class="mcp-mounting">
            <option value="direct" ${mounting === 'direct' ? 'selected' : ''}>direct（每个工具一个定义）</option>
            <option value="meta" ${mounting === 'meta' ? 'selected' : ''}>meta（只挂 mcp_call）</option>
          </select></div>
          <div class="field"><label><input class="mcp-enabled" type="checkbox" ${server.enabled !== false ? 'checked' : ''} /> 启用这个 server</label></div>
          <div class="field"><button type="button" class="btn btn-danger btn-small mcp-remove">删除</button></div>
        </div>
      </div>
    </details>`;
}

function hueOf(text) {
  let hash = 0;
  for (const char of String(text || '')) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

function renderMcpSection(c) {
  const mcp = c.mcp || {};
  const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
  return `
    <h3 id="settings-mcp">MCP 工具</h3>
    <div class="mcp-hero">
      <div>
        <div class="mcp-hero-title">把外部工具接进群聊</div>
        <div class="hint">MCP Server 等价于执行本机命令，只接你信任的。导入后先改目录/令牌，保存再重载。</div>
      </div>
      <div class="checkbox-row mcp-master"><input type="checkbox" id="cfg-mcp-enabled" ${mcp.enabled === true ? 'checked' : ''} />
        <label for="cfg-mcp-enabled">启用 MCP</label></div>
      <div class="hint" id="mcp-resources-note">只读资源服务：<code>node src/mcp/resource-server.js</code>（stdio，与主进程同数据目录）。外部 MCP 客户端接上后可读三类资源：全局人物记忆、群梗库、待触发提醒——没有写路径，也没有会话记录与凭据。</div>
    </div>
    <div class="mcp-toolbar">
      <input type="search" id="mcp-registry-query" placeholder="搜索预设或官方 Registry…" />
      <button type="button" class="btn btn-small" id="mcp-preset-search">搜索预设</button>
      <button type="button" class="btn btn-small" id="mcp-registry-search">官方 Registry</button>
      <button type="button" class="btn btn-small" id="mcp-add-server">＋ 自定义 server</button>
      <span class="muted" id="mcp-registry-result" aria-live="polite"></span>
    </div>
    <div id="mcp-registry-results" class="mcp-catalog-grid"></div>
    <div class="mcp-section-label">常用预设 <span>按群聊场景挑的，导入后仍要确认命令和权限</span></div>
    <div id="mcp-preset-list" class="mcp-catalog-grid"><div class="mcp-empty">加载中…</div></div>
    <div class="mcp-section-label">官方 Registry 最近更新 <span>只列可导入的 stdio server</span></div>
    <div id="mcp-registry-default" class="mcp-catalog-grid"><div class="mcp-empty">加载中…</div></div>
    <div class="hint">官方 Registry 是目录/API，不是一键安装商店；完整目录见
      <a href="https://registry.modelcontextprotocol.io/" target="_blank" rel="noreferrer">registry.modelcontextprotocol.io</a> 或
      <a href="https://glama.ai/mcp/servers" target="_blank" rel="noreferrer">Glama</a>。</div>
    <h3 id="settings-mcp-servers">已配置的 server</h3>
    <div class="mcp-toolbar">
      <button type="button" class="btn btn-small" id="mcp-reload">重新加载</button>
      <span class="muted" id="mcp-reload-result"></span>
      <span class="mcp-status-line" id="mcp-status">读取中…</span>
    </div>
    <div id="mcp-servers" class="mcp-server-list">${servers.length ? servers.map((server) => mcpServerRowHtml(server)).join('') : '<div class="mcp-empty">还没有 server：从上面的预设导入，或点「＋ 自定义 server」。</div>'}</div>`;
}

function renderKnowledgeSection(c) {
  const k = c.knowledge || {};
  return `
    <h3 id="settings-knowledge">轻量知识库</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-knowledge-enabled" ${k.enabled === true ? 'checked' : ''} />
      <label for="cfg-knowledge-enabled">启用本地知识库（只读 .md / .txt，不接 embedding）</label></div>
    <div class="field-row">
      <div class="field"><label>目录（留空 = data/knowledge）</label><input type="text" id="cfg-knowledge-dir" value="${esc(k.dir || '')}" placeholder="data/knowledge" /></div>
      <div class="field"><label>最多返回片段</label><input type="number" id="cfg-knowledge-maxresults" min="1" max="10" value="${esc(k.maxResults ?? 4)}" /></div>
      <div class="field"><label>切片大小（字符）</label><input type="number" id="cfg-knowledge-chunk" min="200" max="4000" value="${esc(k.chunkChars ?? 900)}" /></div>
      <div class="field"><label>切片重叠（字符）</label><input type="number" id="cfg-knowledge-overlap" min="0" max="2000" value="${esc(k.overlapChars ?? 120)}" /></div>
    </div>
    <div class="hint">把群规/FAQ/手册放进这个目录，保存后模型可通过 knowledge_search 检索并带来源回答。不是完整 RAG：没有向量检索、没有 PDF/DOCX 解析。</div>
    <div class="field"><label>文档</label><div class="hint" id="knowledge-files">读取中…</div></div>
    <div class="field"><label>上传文档（.md / .txt，可多选）</label>
      <label class="file-picker" for="knowledge-file-upload">
        <span class="btn btn-small">选择文件</span>
        <span class="file-picker-name" id="knowledge-file-upload-name">未选择文件</span>
        <input type="file" id="knowledge-file-upload" class="file-picker-input" accept=".md,.txt,text/plain,text/markdown" multiple />
      </label>
    </div>
    <div class="field-row">
      <div class="field"><label>文件名</label><input type="text" id="knowledge-file-name" placeholder="群规.md" /></div>
      <div class="field"><label>操作</label>
        <div class="settings-inline-actions">
          <button type="button" class="btn btn-small" id="knowledge-file-save">添加 / 覆盖</button>
          <button type="button" class="btn btn-small" id="knowledge-reindex">重建索引</button>
          <span class="muted" id="knowledge-file-result"></span>
        </div>
      </div>
    </div>
    <div class="field"><label>内容（覆盖同名文件；只支持 .md / .txt）</label>
      <textarea id="knowledge-file-content" rows="5" placeholder="把文档正文粘贴到这里，或直接放进 data/knowledge 目录"></textarea></div>
    <div class="field"><label>索引状态</label><div class="hint" id="knowledge-status">读取中…</div></div>`;
}

function renderMemesSection(c) {
  const groups = Array.isArray(c?.allow?.groups) ? c.allow.groups.map((id) => String(id).trim()).filter(Boolean) : [];
  const privates = Array.isArray(c?.allow?.private) ? c.allow.private.map((id) => String(id).trim()).filter(Boolean) : [];
  const seen = new Set();
  const chats = [];
  for (const id of groups) {
    const key = `group:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chats.push({ key, kind: 'group', id });
  }
  for (const id of privates) {
    const key = `private:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chats.push({ key, kind: 'private', id });
  }
  const groupsList = chats.filter((chat) => chat.kind === 'group');
  const privatesList = chats.filter((chat) => chat.kind === 'private');
  const optionHtml = (chat, index) => {
    const label = chat.kind === 'group' ? `群 ${chat.id}` : `私聊 ${chat.id}`;
    return `<label class="meme-chat-option" data-chatkey="${esc(chat.key)}" data-search="${esc(`${label} ${chat.key}`)}">
      <input type="checkbox" class="meme-chat-check" data-chatkey="${esc(chat.key)}" id="meme-chat-${index}" />
      <span class="meme-chat-option-label">${esc(label)}</span>
    </label>`;
  };
  let index = 0;
  const groupRows = groupsList.map((chat) => optionHtml(chat, index++)).join('');
  const privateRows = privatesList.map((chat) => optionHtml(chat, index++)).join('');
  return `
    <h3 id="settings-memes">群梗库</h3>
    <div class="hint">群友解释过一次的梗/黑话/外号，按会话保存。机器人会优先按这里的含义理解，不必每次重新搜索；也可以手动补充、删除。
      群友在聊天里说“X 就是……，记一下”时，模型会调用 meme_remember；没记住就在下面手动添加。
      这里只记梗的含义/用法，不记隐私和人物评价。</div>
    <div class="field"><label>添加到哪些会话</label>
      ${chats.length ? `
        <div class="meme-chat-picker">
          <div class="meme-chat-toolbar">
            <input type="search" id="memes-chat-search" aria-label="搜索群聊或私聊" />
            <button type="button" class="btn btn-small" id="memes-select-visible">选中筛选结果</button>
            <button type="button" class="btn btn-small" id="memes-clear-selected">清空</button>
            <span class="muted" id="memes-selected-count">已选 0 个</span>
          </div>
          <div class="meme-chat-options" id="memes-chat-options">
            ${groupRows ? `<div class="meme-chat-group-title">群聊（${groupsList.length}）</div>${groupRows}` : ''}
            ${privateRows ? `<div class="meme-chat-group-title">私聊（${privatesList.length}）</div>${privateRows}` : ''}
          </div>
          <div class="meme-chat-chips" id="memes-chat-chips"><span class="muted">还没选会话</span></div>
        </div>` : '<div class="hint">还没有已添加的群聊/私聊；先在「聊天白名单」里加一个。</div>'}
      <div class="hint">列表来自已添加的群聊/私聊白名单。群多时用搜索框筛选；选中的会话会出现在下面，点 × 可取消。</div>
    </div>
    <div class="field"><label>或手动输入会话 key（白名单为空/临时会话时用）</label>
      <input type="text" id="meme-chatkey-manual" maxlength="80" aria-label="手动输入会话 key" /></div>
    <div class="field-row">
      <div class="field"><label>梗 / 黑话 / 外号</label><input type="text" id="meme-term" maxlength="40" /></div>
      <div class="field"><label>别名（逗号分隔，可选）</label><input type="text" id="meme-aliases" maxlength="200" /></div>
    </div>
    <div class="field"><label>含义</label><input type="text" id="meme-meaning" maxlength="300" /></div>
    <div class="field"><label>用法 / 例句（可选）</label><input type="text" id="meme-usage" maxlength="240" />
      <div class="hint">含义和用法写成人话；别名用逗号分隔。这里只记录群友确认过的词义，不记隐私和人物评价。</div>
    </div>
    <div class="settings-inline-actions">
      <button type="button" class="btn btn-small" id="memes-add">添加到选中会话</button>
      <span class="muted" id="memes-result"></span>
    </div>
    <div class="field"><label>已有梗库</label><div class="hint" id="memes-list">读取中…</div></div>`;
}

function renderModerationSection(c) {
  const enabled = c.moderation?.enabled !== false;
  const actions = c.moderation?.actions || {};
  const groups = Array.isArray(c.moderation?.groups) ? c.moderation.groups.join(',') : '';
  const adminCommands = c.admin?.groupCommands || {};
  const adminCommandGroups = Array.isArray(adminCommands.chats) ? adminCommands.chats.join(',') : '';
  return `
    <h3 id="settings-moderation">群管理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-moderation-enabled" ${enabled ? 'checked' : ''} />
      <label for="cfg-moderation-enabled">允许群管理工具</label></div>
    <div class="field-row">
      <div class="checkbox-row"><input type="checkbox" id="cfg-moderation-ban" ${actions.ban !== false ? 'checked' : ''} /><label for="cfg-moderation-ban">禁言 / 解禁</label></div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-moderation-kick" ${actions.kick !== false ? 'checked' : ''} /><label for="cfg-moderation-kick">移出群</label></div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-moderation-recall" ${actions.recall !== false ? 'checked' : ''} /><label for="cfg-moderation-recall">撤回消息</label></div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-moderation-admin" ${actions.admin !== false ? 'checked' : ''} /><label for="cfg-moderation-admin">设置 / 取消管理员</label></div>
    </div>
    <div class="field"><label>只在哪些群生效（逗号分隔群号；留空 = 所有允许的群）</label>
      <input type="text" id="cfg-moderation-groups" value="${esc(groups)}" placeholder="433397830" /></div>
    <h3>群内管理员只读命令</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-admin-group-commands" ${adminCommands.enabled === true ? 'checked' : ''} />
      <label for="cfg-admin-group-commands">允许全局管理员在群内使用只读命令</label></div>
    <div class="field"><label>允许的群号（逗号分隔；留空 = 所有允许的群）</label>
      <input type="text" id="cfg-admin-group-chats" value="${esc(adminCommandGroups)}" placeholder="433397830" /></div>
    <div class="hint">
      群内只开放「状态」「行为卡」「最近决策」「结束游戏」；同意/拒绝/确认码仍必须私聊管理员，
      不会把审批短码发到群里。命令消息不会进入模型或长期记忆。
    </div>
    <div class="hint">
      只对全局管理员开放，而且必须是本批次最后一条发言；不能对自己或管理员执行。
      关掉总开关或某一项后，对应工具会从模型工具表里摘除，模型看不到也不会调用。
    </div>`;
}

async function reloadMcp() {
  await api('/api/mcp/reload', { method: 'POST', body: JSON.stringify({}) });
  await hydrateExtensionStatus();
}

function renderCatalog(box, items) {
  if (!box) return;
  box.__results = Array.isArray(items) ? items : [];
  box.innerHTML = box.__results.length
    ? box.__results.map((item, index) => {
      const source = item.source === 'preset' ? '预设' : '官方';
      const category = item.category || (item.source === 'preset' ? '效率' : '官方目录');
      const initial = String(item.title || item.name || '?').slice(0, 1).toUpperCase();
      const meta = [source, category, item.version ? `v${item.version}` : ''].filter(Boolean).join(' · ');
      const command = item.config?.command || '';
      return `<article class="mcp-card">
        <div class="mcp-card-head">
          <span class="mcp-tile" style="--mcp-h:${hueOf(item.id || item.name)}">${esc(initial)}</span>
          <div class="mcp-card-title"><strong>${esc(item.title || item.name)}</strong><span>${esc(meta)}</span></div>
          <button type="button" class="btn btn-small mcp-registry-import" data-index="${index}" ${item.unsupported ? 'disabled' : ''}>${item.unsupported ? '仅远程' : '导入'}</button>
        </div>
        <div class="mcp-card-desc">${esc(item.description || '')}</div>
        <div class="mcp-card-foot">
          <span class="mcp-badge">stdio</span>
          ${command ? `<span class="mcp-badge">${esc(command)}</span>` : ''}
          ${item.unsupported ? `<span class="mcp-badge is-warn">${esc(item.reason || '不支持 stdio')}</span>` : ''}
        </div>
      </article>`;
    }).join('')
    : '<div class="mcp-empty">没有可导入的 stdio server。</div>';
}

function attachCatalogImport(box) {
  if (!box || box.dataset.importBound === '1') return;
  box.dataset.importBound = '1';
  box.addEventListener('click', (event) => {
    const button = event.target.closest('.mcp-registry-import');
    if (!button) return;
    const item = box.__results?.[Number(button.dataset.index)];
    if (!item?.config) return;
    const servers = $('#mcp-servers');
    if (!servers) return;
    servers.querySelector('.mcp-empty')?.remove();
    servers.insertAdjacentHTML('beforeend', mcpServerRowHtml(item.config, { open: true }));
    servers.lastElementChild?.scrollIntoView({ block: 'nearest' });
    button.disabled = true;
    button.textContent = '已导入，记得保存';
  });
}

function bindExtensionSettings() {
  const runRegistrySearch = async (endpoint, button) => {
    const query = String($('#mcp-registry-query')?.value || '').trim();
    const result = $('#mcp-registry-result');
    const box = $('#mcp-registry-results');
    if (!query) { if (result) result.textContent = '先填关键词'; return; }
    button.disabled = true;
    if (result) result.textContent = '搜索中…';
    try {
      const data = await api(`${endpoint}?query=${encodeURIComponent(query)}`);
      const items = Array.isArray(data.results) ? data.results : [];
      if (result) result.textContent = items.length ? `${items.length} 个结果` : '没有结果';
      renderCatalog(box, items);
    } catch (error) {
      if (result) result.textContent = `失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  };
  const presetSearch = $('#mcp-preset-search');
  if (presetSearch) presetSearch.addEventListener('click', () => runRegistrySearch('/api/mcp/presets', presetSearch));
  $('#mcp-registry-query')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    presetSearch?.click();
  });
  const registrySearch = $('#mcp-registry-search');
  if (registrySearch) registrySearch.addEventListener('click', () => runRegistrySearch('/api/mcp/registry', registrySearch));
  for (const id of ['#mcp-registry-results', '#mcp-preset-list', '#mcp-registry-default']) {
    attachCatalogImport($(id));
  }
  const add = $('#mcp-add-server');
  const box = $('#mcp-servers');
  if (add && box) {
    add.addEventListener('click', () => {
      let n = 1;
      while (box.querySelector(`.mcp-server[data-id="server${n}"]`)) n += 1;
      box.insertAdjacentHTML('beforeend', mcpServerRowHtml({
        id: `server${n}`,
        enabled: true,
        command: '',
        args: [],
        env: {},
        timeoutMs: 30000,
        maxCallsPerMinute: 30,
        toolMounting: 'direct',
        permissionIsolation: false,
        memoryMb: 0
      }, { open: true }));
    });
  }
  if (box) {
    box.addEventListener('click', (event) => {
      const button = event.target.closest('.mcp-remove');
      if (button) button.closest('.mcp-server')?.remove();
    });
  }
  const reload = $('#mcp-reload');
  if (reload) {
    reload.addEventListener('click', async () => {
      const result = $('#mcp-reload-result');
      reload.disabled = true;
      if (result) result.textContent = '正在重载…';
      try {
        await reloadMcp();
        if (result) result.textContent = '已重载';
      } catch (error) {
        if (result) result.textContent = `失败：${error.message}`;
      }
      reload.disabled = false;
    });
  }
  const upload = $('#knowledge-file-upload');
  if (upload) {
    upload.addEventListener('change', async () => {
      const result = $('#knowledge-file-result');
      const files = [...(upload.files || [])];
      const nameBox = $('#knowledge-file-upload-name');
      if (nameBox) nameBox.textContent = files.length ? files.map((file) => file.name).join('、') : '未选择文件';
      if (!files.length) return;
      upload.disabled = true;
      const done = [];
      for (const file of files) {
        if (file.size > 2 * 1024 * 1024) { done.push(`${file.name}：超过 2MB`); continue; }
        try {
          const content = await file.text();
          await api('/api/knowledge/files', {
            method: 'POST', body: JSON.stringify({ name: file.name, content })
          });
          done.push(`${file.name}：已上传`);
        } catch (error) {
          done.push(`${file.name}：${error.message}`);
        }
      }
      if (result) result.textContent = done.join('；');
      upload.value = '';
      if (nameBox) nameBox.textContent = '未选择文件';
      upload.disabled = false;
      await hydrateExtensionStatus();
    });
  }
  const saveDoc = $('#knowledge-file-save');
  if (saveDoc) {
    saveDoc.addEventListener('click', async () => {
      const result = $('#knowledge-file-result');
      const name = String($('#knowledge-file-name')?.value || '').trim();
      const content = String($('#knowledge-file-content')?.value || '');
      saveDoc.disabled = true;
      if (result) result.textContent = '正在写入…';
      try {
        const data = await api('/api/knowledge/files', {
          method: 'POST', body: JSON.stringify({ name, content })
        });
        if (result) result.textContent = data.ok ? `已写入 ${data.file?.name || name}` : `失败：${data.error || ''}`;
        if (data.ok) {
          const box = $('#knowledge-file-content');
          if (box) box.value = '';
          await hydrateExtensionStatus();
        }
      } catch (error) {
        if (result) result.textContent = `失败：${error.message}`;
      } finally {
        saveDoc.disabled = false;
      }
    });
  }
  const reindex = $('#knowledge-reindex');
  if (reindex) {
    reindex.addEventListener('click', async () => {
      reindex.disabled = true;
      try { await api('/api/knowledge/reindex', { method: 'POST', body: JSON.stringify({}) }); }
      catch { /* 状态接口会显示 */ }
      await hydrateExtensionStatus();
      reindex.disabled = false;
    });
  }
  const filesBox = $('#knowledge-files');
  if (filesBox) {
    filesBox.addEventListener('click', async (event) => {
      const button = event.target.closest('.knowledge-file-remove');
      if (!button) return;
      button.disabled = true;
      try {
        await api('/api/knowledge/files', { method: 'DELETE', body: JSON.stringify({ name: button.dataset.name }) });
      } catch { /* 状态接口会显示 */ }
      await hydrateExtensionStatus();
    });
  }
  const memeChatOptions = $('#memes-chat-options');
  const memeChatChips = $('#memes-chat-chips');
  const memeSelectedCount = $('#memes-selected-count');
  const selectedChatInputs = () => [...document.querySelectorAll('.meme-chat-check:checked')];
  const selectedChatKeys = () => selectedChatInputs()
    .map((input) => input.dataset.chatkey)
    .filter(Boolean);
  const setChatCheck = (input, selected) => {
    if (!input) return;
    input.checked = selected;
    input.closest('.meme-chat-option')?.classList.toggle('is-selected', selected);
  };
  const renderMemeChatChips = () => {
    if (!memeChatChips) return;
    const selected = selectedChatInputs();
    if (memeSelectedCount) memeSelectedCount.textContent = `已选 ${selected.length} 个`;
    memeChatChips.innerHTML = selected.length
      ? selected.map((input) => {
        const row = input.closest('.meme-chat-option');
        return `<span class="meme-chat-chip">${esc(row?.querySelector('.meme-chat-option-label')?.textContent || input.dataset.chatkey)}
          <button type="button" class="meme-chat-chip-remove" data-chatkey="${esc(input.dataset.chatkey)}" aria-label="取消选择">×</button></span>`;
      }).join('')
      : '<span class="muted">还没选会话</span>';
  };
  const filterMemeChatOptions = () => {
    if (!memeChatOptions) return;
    const query = String($('#memes-chat-search')?.value || '').trim().toLowerCase();
    for (const node of memeChatOptions.querySelectorAll('.meme-chat-option')) {
      const hit = !query || String(node.dataset.search || '').toLowerCase().includes(query);
      node.hidden = !hit;
    }
    for (const title of memeChatOptions.querySelectorAll('.meme-chat-group-title')) {
      let node = title.nextElementSibling;
      let visible = false;
      while (node && !node.classList.contains('meme-chat-group-title')) {
        if (node.classList.contains('meme-chat-option') && !node.hidden) { visible = true; break; }
        node = node.nextElementSibling;
      }
      title.hidden = !visible;
    }
  };
  if (memeChatOptions) {
    memeChatOptions.addEventListener('change', (event) => {
      const input = event.target.closest('.meme-chat-check');
      if (!input) return;
      input.closest('.meme-chat-option')?.classList.toggle('is-selected', input.checked);
      renderMemeChatChips();
    });
  }
  $('#memes-chat-search')?.addEventListener('input', filterMemeChatOptions);
  $('#memes-select-visible')?.addEventListener('click', () => {
    for (const input of document.querySelectorAll('.meme-chat-check')) {
      if (!input.closest('.meme-chat-option')?.hidden) setChatCheck(input, true);
    }
    renderMemeChatChips();
  });
  $('#memes-clear-selected')?.addEventListener('click', () => {
    for (const input of document.querySelectorAll('.meme-chat-check')) setChatCheck(input, false);
    renderMemeChatChips();
  });
  memeChatChips?.addEventListener('click', (event) => {
    const button = event.target.closest('.meme-chat-chip-remove');
    if (!button) return;
    const input = [...document.querySelectorAll('.meme-chat-check')]
      .find((node) => node.dataset.chatkey === button.dataset.chatkey);
    setChatCheck(input, false);
    renderMemeChatChips();
  });

  const memeAdd = $('#memes-add');
  if (memeAdd) {
    memeAdd.addEventListener('click', async () => {
      const result = $('#memes-result');
      const selected = selectedChatKeys();
      const manual = String($('#meme-chatkey-manual')?.value || '').trim();
      if (manual && !selected.includes(manual)) selected.push(manual);
      const base = {
        term: String($('#meme-term')?.value || '').trim(),
        meaning: String($('#meme-meaning')?.value || '').trim(),
        usage: String($('#meme-usage')?.value || '').trim(),
        aliases: String($('#meme-aliases')?.value || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean)
      };
      if (!selected.length) { if (result) result.textContent = '先在上面的会话选择器里选群聊/私聊'; return; }
      if (!base.term || !base.meaning) { if (result) result.textContent = '梗名和含义都不能为空'; return; }
      memeAdd.disabled = true;
      if (result) result.textContent = `正在写入 ${selected.length} 个会话…`;
      let saved = 0;
      const failed = [];
      try {
        for (const chatKey of selected) {
          try {
            const data = await api('/api/memes', {
              method: 'POST',
              body: JSON.stringify({ ...base, chatKey })
            });
            if (data.ok) saved += 1;
            else failed.push(`${chatKey}：${data.error || '失败'}`);
          } catch (error) {
            failed.push(`${chatKey}：${error.message}`);
          }
        }
        if (result) {
          result.textContent = `已写入 ${saved} 个会话${failed.length ? `；失败：${failed.join('；')}` : ''}`;
        }
        if (saved) {
          for (const id of ['#meme-term', '#meme-meaning', '#meme-usage', '#meme-aliases', '#meme-chatkey-manual']) {
            const node = $(id); if (node) node.value = '';
          }
          await hydrateExtensionStatus();
        }
      } finally {
        memeAdd.disabled = false;
      }
    });
  }
  const memesBox = $('#memes-list');
  if (memesBox) {
    memesBox.addEventListener('click', async (event) => {
      const button = event.target.closest('.meme-remove');
      if (!button) return;
      const { askForConfirmation } = await import('../core/dom-util.js');
      if (!await askForConfirmation(`删除「${button.dataset.term || '这条梗'}」？`)) return;
      button.disabled = true;
      try {
        await api('/api/memes', { method: 'DELETE', body: JSON.stringify({ id: button.dataset.id }) });
        const result = $('#memes-result');
        if (result) result.textContent = `已删除「${button.dataset.term || '这条梗'}」`;
      } catch (error) {
        const result = $('#memes-result');
        if (result) result.textContent = `删除失败：${error.message}`;
      }
      await hydrateExtensionStatus();
    });
  }
}

async function hydrateMemeChatNames() {
  const box = $('#memes-chat-options');
  if (!box) return;
  const [groupResult, friendResult] = await Promise.allSettled([
    api('/api/onebot/groups'),
    api('/api/onebot/friends')
  ]);
  const names = new Map();
  if (groupResult.status === 'fulfilled' && Array.isArray(groupResult.value?.groups)) {
    for (const group of groupResult.value.groups) names.set(`group:${group.id}`, group.name);
  }
  if (friendResult.status === 'fulfilled' && Array.isArray(friendResult.value?.friends)) {
    for (const friend of friendResult.value.friends) names.set(`private:${friend.id}`, friend.name);
  }
  for (const option of box.querySelectorAll('.meme-chat-option')) {
    const key = String(option.dataset.chatkey || '');
    const [kind, id] = key.split(':');
    const name = String(names.get(key) || '').trim();
    if (!name || name === id) continue;
    const label = option.querySelector('.meme-chat-option-label');
    if (label) label.textContent = `${kind === 'group' ? '群' : '私聊'} ${id} · ${name}`;
    option.dataset.search = `${option.dataset.search || ''} ${name}`.trim();
  }
}

async function hydrateExtensionStatus() {
  const mcpBox = $('#mcp-status');
  if (mcpBox) {
    try {
      const data = await api('/api/mcp');
      const rows = Array.isArray(data.status) ? data.status : [];
      if (!rows.length) mcpBox.textContent = '未配置或未启用 MCP server';
      else if (rows.every((row) => row.globalEnabled === false)) mcpBox.textContent = `MCP 未启用（已保存 ${rows.length} 个 server）`;
      else {
        mcpBox.innerHTML = rows.map((row) => {
          const stateText = row.ready ? '就绪' : row.starting ? '启动中' : '未就绪';
          const tools = row.tools?.length ? ` · 工具：${row.tools.join(', ')}` : '';
          const sandbox = row.sandboxKind && row.sandboxKind !== 'none'
            ? ` · 沙箱：${row.sandboxKind}${row.netIsolated ? '·禁网' : ''}${row.fsIsolated ? '·只读FS' : ''}`
            : row.unsandboxed ? ' · 沙箱：未隔离（已显式信任）' : ' · 沙箱：未隔离';
          const err = row.error ? ` · ${row.error}` : '';
          return `<div>${esc(row.id)}：${stateText}${esc(tools)}${esc(sandbox)}${esc(err)}</div>`;
        }).join('');
      }
      for (const badge of document.querySelectorAll('[data-mcp-state]')) {
        const row = rows.find((item) => item.id === badge.dataset.mcpState);
        if (!row) continue;
        badge.textContent = !row.globalEnabled || row.enabled === false
          ? '未启用'
          : row.ready ? '就绪' : row.starting ? '启动中' : row.error ? '未就绪' : '未就绪';
        badge.className = `mcp-server-state ${row.ready && row.enabled ? 'is-ready' : row.error ? 'is-error' : ''}`;
      }
    } catch (error) {
      mcpBox.textContent = `读取失败：${error.message}`;
    }
  }
  const presetList = $('#mcp-preset-list');
  if (presetList) {
    try {
      const data = await api('/api/mcp/presets');
      renderCatalog(presetList, Array.isArray(data.results) ? data.results : []);
    } catch (error) {
      presetList.textContent = `读取失败：${error.message}`;
    }
  }
  const registryDefault = $('#mcp-registry-default');
  if (registryDefault) {
    void (async () => {
      try {
        const data = await api('/api/mcp/registry');
        const items = (Array.isArray(data.results) ? data.results : []).filter((item) => !item.unsupported);
        if (!items.length) {
          registryDefault.innerHTML = '<div class="hint">官方 Registry 最近更新里没有可直接导入的 stdio server；可以用上面的搜索，或先用常用预设。</div>';
        } else {
          renderCatalog(registryDefault, items.slice(0, 10));
        }
      } catch (error) {
        registryDefault.innerHTML = `<div class="hint">官方 Registry 暂时不可达：${esc(error.message)}。常用预设仍可离线使用。</div>`;
      }
    })();
  }
  const kbBox = $('#knowledge-status');
  if (kbBox) {
    try {
      const data = await api('/api/knowledge');
      kbBox.textContent = data.enabled
        ? `${data.available ? '已索引' : '目录不存在'}：${data.files || 0} 个文件，${data.chunks || 0} 个片段 · ${data.dir || ''}`
        : '未启用';
    } catch (error) {
      kbBox.textContent = `读取失败：${error.message}`;
    }
  }
  const filesBox = $('#knowledge-files');
  if (filesBox) {
    try {
      const data = await api('/api/knowledge/files');
      const files = Array.isArray(data.files) ? data.files : [];
      filesBox.innerHTML = files.length
        ? files.map((file) => `<div class="knowledge-file-row">${esc(file.name)} <span class="muted">${Math.round(file.size / 1024)} KB</span>
            <button type="button" class="btn btn-small btn-danger knowledge-file-remove" data-name="${esc(file.name)}">删除</button></div>`).join('')
        : '还没有文档';
    } catch (error) {
      filesBox.textContent = `读取失败：${error.message}`;
    }
  }
  const memesBox = $('#memes-list');
  if (memesBox) {
    try {
      const data = await api('/api/memes');
      const entries = Array.isArray(data.entries) ? data.entries : [];
      memesBox.innerHTML = entries.length
        ? entries.map((entry) => `<div class="knowledge-file-row"><b>${esc(entry.term)}</b>
            <span class="muted">${esc(entry.chatKey)}</span>：${esc(entry.meaning)}
            ${entry.usage ? `<span class="muted">；用法：${esc(entry.usage)}</span>` : ''}
            <button type="button" class="btn btn-small btn-danger meme-remove" data-id="${esc(entry.id)}" data-term="${esc(entry.term)}">删除</button></div>`).join('')
        : '还没有梗；群友解释后机器人会自动记，也可以在上面手动添加。';
    } catch (error) {
      memesBox.textContent = `读取失败：${error.message}`;
    }
  }
  await hydrateMemeChatNames();
}

export { bindExtensionSettings, hydrateExtensionStatus, reloadMcp, renderKnowledgeSection, renderMcpSection, renderMemesSection, renderModerationSection };
