#!/usr/bin/env node
// 浏览器冒烟用的真实服务：临时数据目录 + 固定端口 + 一个无网络的测试插件。
// Playwright 的 webServer 负责启动/停止它；测试进程通过 test/browser/constants.mjs 共享端口与令牌。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { E2E_GROUP, E2E_PLUGIN_ID, E2E_PORT, E2E_TOKEN } from '../test/browser/constants.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-e2e-console-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.env.QQ_AGENT_LOG_LEVEL ||= 'error';

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { requestPendingApproval } = await import('../src/plugins/grants.js');

function writeFixturePlugin() {
  const dir = path.join(dataDir, 'plugins', E2E_PLUGIN_ID);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id: E2E_PLUGIN_ID,
    apiVersion: 2,
    name: '浏览器测试插件',
    version: '1.0.0',
    description: 'Playwright 冒烟用的最小插件（无网络、无依赖）',
    entry: 'index.mjs',
    capabilities: ['tools', 'approval'],
    approvals: [
      { action: 'write', label: '写一条测试内容', description: '仅用于浏览器冒烟' }
    ],
    tools: [
      {
        name: 'write',
        description: '写一条测试内容（冒烟桩件，不产生外部副作用）',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '目标' },
            text: { type: 'string', description: '正文' }
          },
          required: ['target', 'text']
        },
        action: 'write',
        actionTarget: 'target',
        actionPreview: 'text'
      }
    ]
  };
  fs.writeFileSync(path.join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.mjs'), `const send = (m) => process.stdout.write(\`\${JSON.stringify(m)}\\n\`);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i = buffer.indexOf('\\n');
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) {
      const m = JSON.parse(line);
      if (m.method === 'init') send({ id: m.id, result: { ok: true } });
      else if (m.method === 'ping') send({ id: m.id, result: { rss: 16 } });
      else if (m.method === 'probe') send({ id: m.id, result: { ok: true, info: { account: 'fixture' } } });
      else if (m.method === 'callTool') send({ id: m.id, result: { ok: true } });
      else if (m.method === 'shutdown') process.exit(0);
      else send({ id: m.id, result: {} });
    }
    i = buffer.indexOf('\\n');
  }
});
`);
}

async function startMarketFixture() {
  const source = path.resolve(import.meta.dirname, '../examples/skills/trip-planner');
  const texts = {};
  for (const name of ['skill.json', 'SKILL.md']) texts[name] = fs.readFileSync(path.join(source, name), 'utf8');
  const hashes = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, crypto.createHash('sha256').update(text).digest('hex')]));
  const baseEntry = {
    id: 'trip-planner',
    name: '出行规划',
    description: '浏览器冒烟用的可安装技能。',
    preview: '这是索引摘要，查看完整说明才下载文件。',
    version: '1.0.0',
    author: 'e2e',
    category: '测试',
    allowedTools: ['web_search', 'send_message'],
    triggers: ['规划行程'],
    files: Object.fromEntries(Object.entries(hashes).map(([name, sha256]) => [name, { path: `/files/${name}`, sha256, bytes: Buffer.byteLength(texts[name]) }]))
  };
  // 额外条目只用于浏览/筛选/分页，文件仍指向同一份测试包。
  const payload = {
    version: 1,
    name: '浏览器测试技能索引',
    updatedAt: '2026-10-26',
    skills: [baseEntry, ...Array.from({ length: 14 }, (_, index) => ({
      ...baseEntry,
      id: `demo-${String(index + 1).padStart(2, '0')}`,
      name: `示例技能 ${String(index + 1).padStart(2, '0')}`,
      category: index % 2 ? '效率' : '生活'
    }))]
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    const name = String(req.url || '').replace('/files/', '');
    if (texts[name]) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(texts[name]);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function buildConfig() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port: E2E_PORT, token: E2E_TOKEN, strictPort: true };
  cfg.runtime = { ...cfg.runtime, mode: 'observe' };
  cfg.allow = { ...cfg.allow, groups: [E2E_GROUP], private: [], allowAllWhenEmpty: false };
  cfg.api = { ...cfg.api, apiKey: '', model: '', baseUrl: '' };
  cfg.autoUpdate = { ...cfg.autoUpdate, enabled: false };
  cfg.proactive = { ...cfg.proactive, enabled: false };
  cfg.dailyMoments = { ...cfg.dailyMoments, enabled: false };
  cfg.qzoneInteractions = { ...cfg.qzoneInteractions, enabled: false };
  cfg.groupDigest = { ...cfg.groupDigest, enabled: false };
  cfg.adminBriefing = { ...cfg.adminBriefing, enabled: false };
  cfg.reminders = { ...cfg.reminders, enabled: false };
  cfg.mcp = { enabled: false, servers: [] };
  cfg.skills = { enabled: true, enabledIds: ['chat-summary'], perChat: {} };
  // 长期记忆页默认藏在实验功能后面；e2e 显式转正，顺带覆盖这个新页签。
  cfg.livingMemory = { ...cfg.livingMemory, enabled: true, graduated: true, mode: 'shadow' };
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
    enabledIds: [E2E_PLUGIN_ID],
    requireIsolation: false,
    networkIsolation: false,
    indexUrl: '',
    indexUrls: []
  };
  return cfg;
}

writeFixturePlugin();
const marketFixture = await startMarketFixture();
const bootConfig = buildConfig();
bootConfig.skills = {
  ...bootConfig.skills,
  indexUrl: `http://127.0.0.1:${marketFixture.port}/index.json`,
  allowPrivateIndex: true
};
updateConfig(bootConfig);
requestPendingApproval(dataDir, {
  pluginId: E2E_PLUGIN_ID,
  pluginName: '浏览器测试插件',
  action: 'write',
  label: '写一条测试内容',
  target: 'demo-target',
  preview: 'playwright smoke body'
});

const { createApp } = await import('../src/console/app.js');
const app = createApp({ log: (...args) => { if (process.env.E2E_VERBOSE) console.log(...args); } });
const { installManualFriendReviewRoute } = await import('../src/console/manual-friend-review-route.js');
installManualFriendReviewRoute(app);
const port = await app.start();
app.memory.append(`group:${E2E_GROUP}`, 'memberImpression', '昨天中午去新开的面馆排队半小时，汤有点咸', { userId: '2001', target: '演示群友' });
// 聊天页、长期记忆页都按真实会话列表渲染；没有消息时这两页只剩空态，浏览器冒烟也就测不到管理区。
app.store.appendIncoming(`group:${E2E_GROUP}`, {
  mid: 'e2e-message-1',
  senderId: '2001',
  senderName: '演示群友',
  text: '今晚八点老地方开黑，别迟到',
  ts: Date.now() - 60 * 60 * 1000
}, { recordOnly: true });
const e2eScope = `group:${E2E_GROUP}`;
await app.livingMemory.create({
  scopeKey: e2eScope,
  type: 'project',
  summary: 'NAS 迁移计划',
  content: '准备把家庭照片从旧群晖迁到新 NAS，周末先做一次增量备份，确认校验通过后再删旧盘。',
  importance: 6.5,
  confidence: 0.9,
  tags: ['NAS', '项目', '备份'],
  entities: ['NAS', '群晖'],
  relations: [{ source: 'NAS 迁移计划', predicate: '涉及', target: '群晖' }]
});
await app.livingMemory.create({
  scopeKey: e2eScope,
  type: 'commitment',
  summary: '周五晚上八点群内开黑',
  content: '群里约好周五 20:00 一起开黑，提前十分钟在群里集合；临时有事要在群里说一声。',
  importance: 5,
  confidence: 0.85,
  tags: ['约定', '游戏'],
  entities: ['周五']
});
console.log(`E2E_READY http://127.0.0.1:${port} data=${dataDir}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (process.env.E2E_VERBOSE) console.log(`[e2e] ${signal}，正在停止`);
  try { await app.stop(); } catch (error) { console.error(`[e2e] stop 失败：${error?.message || error}`); }
  try { await new Promise((resolve) => marketFixture.server.close(resolve)); } catch { /* 忽略 */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* 忽略 */ }
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (error) => { console.error('[e2e] uncaughtException', error); void shutdown('uncaughtException'); });
process.on('unhandledRejection', (error) => { console.error('[e2e] unhandledRejection', error); });
