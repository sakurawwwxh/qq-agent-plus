// 新增控制台开关的接线守卫：控件 id、渲染端、保存端必须同时存在。
// 这类缺口只有真机点保存才看得见（界面显示"已保存"、配置却没变），用静态断言兜住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(repo, ...p), 'utf8');
const chat = read('ui/pages/chat.js');
const save = read('ui/pages/settings-save.js');
const settings = read('ui/pages/settings.js');
const voice = read('ui/pages/settings-voice.js');
const moments = read('ui/pages/moments.js');
const platform = read('ui/pages/platform.js');
const memory = read('ui/pages/memory.js');
const extensions = read('ui/pages/settings-extensions.js');
const format = read('ui/core/format.js');
const pluginSettings = read('ui/pages/plugin-settings.js');

test('插件控制台扫码轮询：两个 poll 都带 channel=console（issue #21）', () => {
  const polls = pluginSettings.match(/action: 'poll'/g) || [];
  const withChannel = pluginSettings.match(/action: 'poll', channel: 'console'/g) || [];
  assert.equal(polls.length, 2, '控制台应只有两处 poll 调用');
  assert.equal(withChannel.length, 2, '两处 poll 都必须带 channel=console，否则旧的 poll 判定会把它当成聊天内非管理员');
});

test('聊天设置：回复纠正 / 拍一拍 / 自主节奏 / 数据保留控件与保存接线', () => {
  for (const id of ['cfg-reply-guard', 'cfg-poke-reply', 'cfg-pacing-enabled',
    'cfg-pacing-default', 'cfg-pacing-min', 'cfg-pacing-max', 'cfg-pacing-instant',
    'cfg-store-maxmessages', 'cfg-store-keepsessions', 'cfg-store-ioprofile',
    'cfg-store-iocustom', 'cfg-store-persistms', 'cfg-store-sqlitesync',
    'cfg-proactive', 'cfg-pro-group', 'cfg-pro-private', 'cfg-pro-followup', 'cfg-pro-selfwake',
    'pro-add-window', 'cfg-humanize-enabled', 'cfg-humanize-preset',
    'cfg-humanize-delay-enabled',
    'cfg-humanize-delay-min', 'cfg-humanize-delay-max', 'cfg-humanize-delay-perchar',
    'cfg-humanize-antaienabled', 'cfg-humanize-blocksevere',
    'cfg-humanize-state-enabled', 'cfg-humanize-relationship-enabled',
    'cfg-humanize-meme-level',
    'cfg-humanize-respect-card', 'humanize-state-text']) {
    assert.ok(chat.includes(`id="${id}"`), `缺少控件 ${id}`);
  }
  assert.match(save, /groupEnabled: chk\('#cfg-pro-group'/,
    '群聊范围开关必须接到保存端，否则界面上勾了也不生效');
  assert.match(save, /privateEnabled: chk\('#cfg-pro-private'/,
    '私聊范围开关必须接到保存端，否则界面上勾了也不生效');
  assert.match(save, /activeHours: \{[\s\S]*?windows:/,
    '主动发言时段必须写进 patch.proactive.activeHours.windows');
  assert.match(save, /patch\.humanize = \{/, '人类化开关必须接到保存端');
  assert.match(save, /memeUse: \{[\s\S]*?level:[\s\S]*?cfg-humanize-meme-level/,
    '梗密度必须写进 patch.humanize.memeUse.level');
  // 卡片化只改外层结构：h3 分组必须真的走到 cardify，单勾选行才会变成右侧开关
  assert.match(settings, /function cardifySettings/);
  assert.match(settings, /function markSwitchRows/);
  assert.match(settings, /cardifySettings\(box\)/);
  assert.match(settings, /id="settings-search"/, '设置侧栏应有搜索入口');
  assert.match(settings, /id="cfg-dirty-note"/, '保存条应显示未保存提示');
  assert.match(settings, /function filterSettingsMenu/);
  assert.match(memory, /function relationshipText/, '人物记忆应展示关系档位');
  assert.match(memory, /relationshipText\(m\.relationship\)/);
  for (const id of ['cfg-mcp-enabled', 'mcp-add-server', 'mcp-reload', 'mcp-status',
    'cfg-knowledge-enabled', 'cfg-knowledge-dir', 'cfg-knowledge-maxresults',
    'cfg-knowledge-chunk', 'cfg-knowledge-overlap', 'knowledge-status',
    'knowledge-file-name', 'knowledge-file-content', 'knowledge-file-save', 'knowledge-reindex', 'knowledge-files',
    'knowledge-file-upload', 'knowledge-file-upload-name', 'mcp-registry-query', 'mcp-registry-search', 'mcp-registry-results', 'mcp-preset-search',
    'mcp-preset-list', 'mcp-registry-default',
    'cfg-moderation-enabled', 'cfg-moderation-ban', 'cfg-moderation-kick',
    'cfg-moderation-recall', 'cfg-moderation-admin', 'cfg-moderation-groups']) {
    assert.ok(extensions.includes(`id="${id}"`), `缺少扩展设置控件 ${id}`);
  }
  assert.match(save, /patch\.mcp = \{ __replace__/, 'MCP server 列表要整段替换');
  assert.match(save, /cwd: read\('\.mcp-cwd'\)/, '保存 MCP server 不能丢掉 cwd');
  assert.match(extensions, /mcp-cwd/, 'MCP 表单要有 cwd 输入');
  assert.match(save, /patch\.knowledge = \{/);
  assert.match(save, /patch\.moderation = \{/);
  // 默认勾选状态与保存端 fallback 必须同口径：群聊默认开、私聊默认关
  assert.match(chat, /id="cfg-pro-group"[^\n]*groupEnabled !== false/);
  assert.match(chat, /id="cfg-pro-private"[^\n]*privateEnabled === true/);
  assert.match(chat, /群聊（独立节奏，按群白名单）/);
  assert.match(chat, /私聊（独立节奏，按私聊白名单）/);
  assert.match(chat, /群聊和私聊各自独立计时/);
  assert.match(chat, /每个群\/私聊独立判定/);
  assert.match(save, /scopeMode:/);
  assert.match(save, /perChatMaxPerTick:/);
  for (const key of ['replyGuardEnabled', 'pokeReplyEnabled']) {
    assert.ok(save.includes(`${key}:`), `保存端缺少 ${key}`);
  }
  assert.match(save, /patch\.pacing = \{/);
  assert.match(save, /maxMessagesPerChat: clampInt/);
  assert.match(save, /keepSessionFiles: numKeep/);
  // 只给三个预设档位，不把毫秒数与 SQLite 同步级别直接丢给用户
  assert.match(save, /IO_PROFILES\[val\('#cfg-store-ioprofile'/);
  for (const [key, ms, sync] of [['balanced', 10000, 'FULL'], ['low', 30000, 'NORMAL'], ['minimal', 60000, 'NORMAL']]) {
    assert.match(format, new RegExp(`${key}: \\{ persistMs: ${ms}, synchronous: '${sync}' \\}`), `${key} 档位映射`);
  }
});

test('记忆 / 预算 / 图片生成 / 群游戏：新开关都接到保存端', () => {
  assert.ok(settings.includes('id="cfg-mem-handoff"'));
  assert.ok(save.includes('handoffEnabled: chk('));
  assert.ok(settings.includes('id="cfg-budget-notify"'));
  assert.ok(save.includes('notify: chk('));
  assert.ok(voice.includes('id="cfg-img-autosend"'));
  assert.ok(save.includes('autoSend: chk('));
  assert.ok(moments.includes('id="cfg-game-maxtime"'));
  assert.ok(save.includes('maxDurationMin: numKeep'));
});

test('平台能力：插件宿主高级项有控件、保存时只提交这几个键', () => {
  for (const id of ['cfg-plugin-memory', 'cfg-plugin-calls', 'cfg-plugin-netiso', 'cfg-plugin-requirenetiso']) {
    assert.ok(platform.includes(`id="${id}"`), `缺少控件 ${id}`);
  }
  assert.match(save, /patch\.plugins = \{/);
  assert.match(save, /limits: \{/);
  assert.match(save, /networkIsolation: chk\(/);
  assert.match(save, /requireNetworkIsolation: chk\(/);
});

test('搜索设置：显示真实搜索链路，并提供搜索自测入口', () => {
  for (const id of ['cfg-searchprovider', 'search-chain-summary', 'cfg-search-test-query', 'cfg-search-test-btn', 'cfg-search-test-meme']) {
    assert.ok(settings.includes(`id="${id}"`), `缺少搜索控件 ${id}`);
  }
  assert.match(settings, /梗查询自动补充/);
  assert.match(read('ui/pages/search-test.js'), /\/api\/web-search\/test/);
  assert.match(read('src/console/routes/search.js'), /'\/api\/web-search\/test'/);
});

test('群梗库：控制台有添加/列表/删除入口，并接到 API', () => {
  for (const id of ['settings-memes', 'memes-chat-search', 'memes-chat-options', 'memes-select-visible', 'memes-clear-selected', 'memes-chat-chips', 'memes-selected-count', 'meme-chatkey-manual', 'meme-term', 'meme-meaning', 'meme-usage', 'meme-aliases', 'memes-add', 'memes-list']) {
    assert.ok(extensions.includes(`id="${id}"`), `缺少梗库控件 ${id}`);
  }
  assert.match(settings, /\['memes', '梗库'\]/);
  assert.match(settings, /memes: \(\) => renderMemesSection\(c\)/);
  assert.match(read('src/console/routes/memes.js'), /'\/api\/memes'/);
  assert.match(read('src/memes/store.js'), /export function rememberMeme/);
});

test('QQ空间：内容来源与草稿/自动发布接到保存端', () => {
  assert.match(save, /source: \['self', 'group', 'mixed'\]/);
  assert.match(save, /autoPublish:/);
  assert.match(moments, /id="cfg-moments-source"/);
  assert.match(moments, /id="cfg-moments-autopublish"/);
});

test('插件待批徽标：绝对定位不占行高、带 aria、可点进待批', () => {
  const html = read('ui/index.html');
  const css = read('ui/style.css');
  const pendingUi = read('ui/pages/plugin-pending.js');
  const pluginPage = read('ui/pages/plugins.js');
  // 徽标必须在 .tab-label 外面：放进 flex column 会多出一行，把左侧导航撑高
  assert.match(html, /<span class="tab-label"><b>插件<\/b><i>市场与已装的扩展<\/i><\/span><em class="pending-badge" data-pending-badge/);
  assert.match(css, /\.pending-badge \{ position: absolute; top: 6px; right: 8px;/);
  assert.match(css, /data-side-rail='1'[\s\S]{0,120}\.pending-badge/);
  assert.match(pendingUi, /aria-label/, '徽标要有可读标签');
  assert.match(pendingUi, /loadPendingBanner/, '插件页顶部汇总条要复用全量待批');
  assert.match(pendingUi, /data-pending-jump/, '点徽标要能自动跳到第一条待批');
  assert.match(pluginPage, /plugins-pending-banner/, '插件页要有待批汇总容器');
  assert.match(pluginPage, /scrollIntoView/, '进入详情后要滚到待批区块');
});
