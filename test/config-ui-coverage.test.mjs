// 配置树 ↔ 控制台入口的覆盖率守卫（2026-11-04）。
//
// 背景：上一轮审查把“配置能保存、功能能跑”当成了“控制台有入口”，没有做配置树和 UI 的
// 全量对照，漏掉了一批只能手改 config.json 的功能。这里做两件事：
//   1) 叶子名扫描：默认配置里出现、但 UI 源码里完全没出现的键，必须显式列入白名单；
//      以后新增“唯一叶子名”的配置却忘了加入口，这条会直接红。
//   2) 关键入口点名：本轮补齐的控件必须有稳定 id，且保存代码必须读取同一个 id；
//      删除、改名或只删渲染保留保存都会红。
//
// 局限：叶子名扫描对 `enabled`/`mode`/`groups`/`apiKeyHost` 这类通用名会假绿，
// 所以本轮新增项另外由第 2 条的 required 控件与保存 selector 列表兜底；
// 实际保存映射由 test/render-test.mjs 的“新增入口的保存映射”用例负责。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/core/config-legacy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

// 故意的配置面：安全边界、部署参数、内部实现细节。
// 这些项不提供控制台入口是有意为之；新增项请先想清楚为什么不该在控制台改。
const CONFIG_ONLY = new Set([
  'tts.apiKeyService',                 // TTS Key 归属的内部标记
  'security.allowPrivateImageHosts',   // SSRF 例外：安全边界，只允许手改后重载
  'security.allowFakeIpDns',
  'security.fakeIpCidrs',
  'onebot.httpAccessToken',            // 控件存在，但字段名只在保存代码里出现（叶子名扫描的已知盲区）
  'customPersonas',                    // 人设页通过 /api/persona-templates 管理，不在 UI 源码里出现该键名
  'plugins.mirrorPrefixes',            // 包镜像源：供应链边界
  'store.batchLimit',                  // 未读扫描的内部上限，不是用户可理解的旋钮
  'store.batchMaxChars',
  'skills.allowPrivateIndex',          // 自建/局域网索引：安全边界
  'server.strictPort',                 // 监听/反代/单实例属于部署参数
  'server.trustedProxies',
  'server.singleInstanceLock'
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (/\.(js|html)$/.test(entry.name)) out.push(file);
  }
  return out;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function leafPaths(value, prefix = '', out = []) {
  for (const [key, child] of Object.entries(value || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) leafPaths(child, full, out);
    else out.push(full);
  }
  return out;
}

test('默认配置的每个叶子键都能在控制台源码里找到，或显式声明为配置面', () => {
  const uiCode = stripComments(walk(UI).map((file) => fs.readFileSync(file, 'utf8')).join('\n'));
  const missing = leafPaths(DEFAULT_CONFIG).filter((full) => {
    const leaf = full.split('.').pop();
    return !uiCode.includes(leaf);
  });
  const unexpected = missing.filter((full) => !CONFIG_ONLY.has(full));
  assert.deepEqual(unexpected, [],
    `这些配置键在控制台源码里完全找不到，也没有列入 CONFIG_ONLY：${unexpected.join(', ')}`);
});

test('本轮补齐的设置入口都有稳定控件（删改会红）', () => {
  const required = {
    'pages/settings.js': [
      'cfg-api-timeout', 'cfg-run-timeout',
      'cfg-denygroups', 'cfg-denyprivate',
      'cfg-mt-enrich-timeout', 'cfg-catchup-count',
      'cfg-search-maxresults', 'cfg-ds-needcontent', 'cfg-tavily-depth',
      'cfg-mem-handoff-ttl', 'cfg-mem-handoff-max'
    ],
    'pages/chat.js': [
      'cfg-failure-notice', 'cfg-failure-notice-cooldown',
      'cfg-pro-followup-delay', 'cfg-pro-followup-cooldown',
      'cfg-humanize-sleep-start', 'cfg-humanize-sleep-end', 'cfg-humanize-cap',
      'cfg-humanize-max-bubbles', 'cfg-humanize-actions-max',
      'cfg-humanize-cooldown-sticker', 'cfg-humanize-cooldown-poke',
      'cfg-humanize-cooldown-voice', 'cfg-humanize-cooldown-react',
      'cfg-context-layering', 'cfg-context-layer-messages', 'cfg-context-layer-chars',
      'cfg-sticker-collect-max-perchat',
      'cfg-direct-wake-delay', 'cfg-max-batch-wait'
    ],
    'pages/moments.js': [
      'cfg-moments-visibility', 'cfg-moments-target-uins', 'cfg-moments-max-prompt', 'cfg-qzi-decision-rounds',
      'cfg-qzi-active-start', 'cfg-qzi-active-end', 'cfg-digest-max'
    ],
    'pages/life-feed.js': ['cfg-lifefeed-rss-urls', 'cfg-lifefeed-rss-per-forage', 'cfg-lifefeed-cooldown'],
    'pages/living-memory.js': ['lm-auto-capture', 'lm-capture-idle', 'lm-rrf-k', 'lm-recent-memory-count'],
    'pages/features.js': ['cfg-outbox-auto-release'],
    'pages/settings-voice.js': [
      'cfg-asr-max-perchat', 'cfg-tts-max', 'cfg-tts-max-perchat',
      'cfg-img-response-format', 'cfg-img-timeout'
    ],
    'app.js': ['control-storage-compress']
  };
  for (const [file, ids] of Object.entries(required)) {
    const source = fs.readFileSync(path.join(UI, file), 'utf8');
    // settingCheck() 等辅助函数会动态拼 id，不能只匹配字面量 id="..."；
    // 但也不能退化成 source.includes(id) —— 那样只看保存代码 `$('#id')` 也会假绿。
    const rendered = (id) => source.includes(`id="${id}"`)
      || source.includes(`settingCheck('${id}'`)
      || source.includes(`settingCheck("${id}"`);
    const absent = ids.filter((id) => !rendered(id));
    assert.deepEqual(absent, [], `${file} 缺少控件：${absent.join(', ')}`);
  }
});

test('新增控件的保存代码读取同一个 id（渲染删了/保存改名都会红）', () => {
  const save = fs.readFileSync(path.join(UI, 'pages', 'settings-save.js'), 'utf8');
  const saveIds = [
    'cfg-mt-enrich-timeout', 'cfg-lifefeed-rss-urls', 'cfg-lifefeed-rss-per-forage',
    'cfg-moments-visibility', 'cfg-moments-target-uins', 'cfg-moments-max-prompt',
    'cfg-qzi-decision-rounds', 'cfg-qzi-active-start', 'cfg-qzi-active-end',
    'cfg-digest-max', 'cfg-lifefeed-cooldown',
    'cfg-mem-handoff-ttl', 'cfg-mem-handoff-max',
    'cfg-api-timeout', 'cfg-run-timeout',
    'cfg-asr-max-perchat', 'cfg-tts-max', 'cfg-tts-max-perchat',
    'cfg-img-response-format', 'cfg-img-timeout',
    'cfg-search-maxresults', 'cfg-ds-needcontent', 'cfg-tavily-depth',
    'cfg-denygroups', 'cfg-denyprivate', 'cfg-direct-wake-delay', 'cfg-max-batch-wait',
    'cfg-pro-followup-delay', 'cfg-pro-followup-cooldown',
    'cfg-humanize-sleep-start', 'cfg-humanize-sleep-end', 'cfg-humanize-cap',
    'cfg-humanize-max-bubbles', 'cfg-humanize-actions-max',
    'cfg-humanize-cooldown-sticker', 'cfg-humanize-cooldown-poke',
    'cfg-humanize-cooldown-voice', 'cfg-humanize-cooldown-react',
    'cfg-sticker-collect-max-perchat', 'cfg-context-layering',
    'cfg-context-layer-messages', 'cfg-context-layer-chars',
    'cfg-failure-notice', 'cfg-failure-notice-cooldown', 'cfg-catchup-count'
  ];
  assert.deepEqual(saveIds.filter((id) => !save.includes(`'#${id}'`)), [], 'settings-save.js 有保存 selector 缺失');

  const living = fs.readFileSync(path.join(UI, 'pages', 'living-memory.js'), 'utf8');
  const livingIds = [
    'lm-auto-capture', 'lm-capture-idle', 'lm-enabled', 'lm-mode', 'lm-private',
    'lm-global', 'lm-shadow-semantic', 'lm-turn-retention', 'lm-max-chars',
    'lm-max-items', 'lm-recall-timeout', 'lm-capture-min', 'lm-groups'
  ];
  assert.deepEqual(livingIds.filter((id) => !living.includes(`'#${id}'`)), [], 'living-memory.js 有保存 selector 缺失');
});

test('MCP 可写目录：渲染控件存在，保存不再硬编码清空 sandbox 字段', () => {
  const save = fs.readFileSync(path.join(UI, 'pages', 'settings-save.js'), 'utf8');
  const extensions = fs.readFileSync(path.join(UI, 'pages', 'settings-extensions.js'), 'utf8');
  assert.match(extensions, /mcp-writable-paths/);
  assert.match(save, /\.mcp-writable-paths/);
  assert.match(save, /const originalId = String\(row\.dataset\?\.id \|\| id\)/);
  assert.match(save, /\.\.\.sandboxBase/);
  assert.doesNotMatch(save, /writablePaths:\s*\[\]/);
});
