// 插件控制台路由（v1 列表/索引/安装/卸载/启停/重载 + v2 设置/凭据/授权/配额）
// （从 console/app.js 拆出，2026-10-31 结构整治 M2）。
// 索引加载（loadIndex）与 6 小时定时刷新仍在 app.js：它们和 start/stop 生命周期绑在一起。
import fs from 'node:fs';
import path from 'node:path';
import { safeFetchBinary } from '../../llm/safe-fetch.js';
import {
  installPlugin, uninstallPlugin, sha256Of, MAX_PLUGIN_ARCHIVE_BYTES, rollbackPlugin
} from '../../plugins/install.js';
import { fetchBinaryWithMirrors } from '../../plugins/mirrors.js';
import { pluginSecretStatus, writePluginSecrets, secretFieldKeys, clearPluginSecrets } from '../../plugins/secrets.js';
import {
  grantsStatus, listPendingApprovals, approvePendingApproval,
  rejectPendingApproval, listPluginWrites, clearPluginGrants, resetPluginGrants
} from '../../plugins/grants.js';

export function registerPluginRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const updateConfig = deps.updateConfig;
  const auditWrite = deps.auditWrite;
  const log = deps.log;
  const dataDir = deps.dataDir;
  const hostVersion = deps.hostVersion;
  const pluginRegistry = deps.pluginRegistry;
  const loadIndex = deps.loadIndex;
  const invalidateIndex = deps.invalidateIndex;
  const getMirrorConfig = deps.mirrorConfig;
  const pluginLog = deps.pluginLog;
  if (!router || !json || !readBody || !getConfig || !updateConfig || !auditWrite || !log
    || !dataDir || !hostVersion || !pluginRegistry || !loadIndex || !invalidateIndex
    || !getMirrorConfig || !pluginLog) {
    throw new Error('registerPluginRoutes 需要 router/json/readBody/getConfig/updateConfig/auditWrite/log/dataDir/hostVersion/registry/索引闭包');
  }

  const pluginError = (res, error, status = 400) => {
    const raw = String(error?.message ?? error);
    const safe = raw
      .replace(/[A-Za-z]:\\[^\s'"]+/g, (hit) => `<路径>/${hit.split(/[\\/]/).pop()}`)
      .replace(/\/(?:home|root|data|tmp|var|opt|srv|app)\/[^\s'"]*/g, (hit) => `<路径>/${hit.split('/').pop()}`);
    return json(res, status, { ok: false, code: error?.code || '', error: safe });
  };

  router.add('GET', '/api/plugins', async (_req, res) =>
    json(res, 200, {
      ...pluginRegistry.list(),
      indexUrl: String(getConfig().plugins?.indexUrl || ''),
      indexUrls: Array.isArray(getConfig().plugins?.indexUrls) ? getConfig().plugins.indexUrls : [],
      lazy: getConfig().plugins?.lazy !== false,
      idleMinutes: Math.max(0, Number(getConfig().plugins?.idleMinutes) || 0),
      // 只读信任视图：发布者公钥与撤回名单（公钥不是秘密；撤回名单是集中下架的依据）
      publishers: getConfig().plugins?.publishers && typeof getConfig().plugins.publishers === 'object'
        ? getConfig().plugins.publishers : {},
      revoked: Array.isArray(getConfig().plugins?.revoked) ? getConfig().plugins.revoked : []
    }));

  // ── 插件 v2：统一设置面板 / 凭据 / 授权与配额 ─────────────────────────────
  // 插件作者不写 HTML：设置项由 manifest.settings 描述，这里只做"按 schema 读写"。
  const pluginEntryOf = (id) => pluginRegistry.list().plugins.find((row) => row.id === id && row.installed) || null;
  const pluginIdValid = (id) => /^[a-z0-9][a-z0-9-]{1,31}$/.test(id);

  router.add('GET', '/api/plugins/settings', async (req, res) => {
    const id = String(new URL(req.url || '/', 'http://x').searchParams.get('id') || '').trim();
    if (!pluginIdValid(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    const entry = pluginEntryOf(id);
    if (!entry) return json(res, 404, { ok: false, error: '这个插件没有安装' });
    const schema = entry.manifest?.settings || { groups: [] };
    const stored = getConfig().plugins?.settings?.[id] || {};
    const secretKeys = secretFieldKeys(schema);
    const values = {};
    for (const group of schema.groups || []) {
      for (const field of group.fields || []) {
        if (field.type === 'secret') continue;
        values[field.key] = stored[field.key] === undefined ? (field.default ?? '') : stored[field.key];
      }
    }
    return json(res, 200, {
      ok: true,
      id,
      schema,
      values,
      secrets: pluginSecretStatus(dataDir, id, secretKeys),
      approvals: entry.manifest?.approvals || [],
      quotas: entry.manifest?.quotas || {},
      grants: grantsStatus(dataDir, id, {
        approvals: entry.manifest?.approvals || [],
        quotas: entry.manifest?.quotas || {}
      }),
      // 写动作开关（默认关）＋ 该插件的待批请求 ＋ 写审计（"日志"页签的数据源）
      switches: getConfig().plugins?.switches?.[id] || {},
      pending: listPendingApprovals(dataDir).filter((item) => item.pluginId === id),
      writes: listPluginWrites(dataDir, id, 30),
      // 登录徽标（可选）：插件实现了 probe 就带一份实测登录态，面板打开即见
      loginInfo: await pluginRegistry.probePlugin(id).then((r) => (r.ok ? { ...r.info, measuredAt: Date.now() } : null)).catch(() => null)
    });
  });

  router.add('POST', '/api/plugins/settings', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    if (!pluginIdValid(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    const entry = pluginEntryOf(id);
    if (!entry) return json(res, 404, { ok: false, error: '这个插件没有安装' });
    const schema = entry.manifest?.settings || { groups: [] };
    const fields = new Map();
    for (const group of schema.groups || []) for (const field of group.fields || []) fields.set(field.key, field);
    const input = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
    const unknown = Object.keys(input).filter((key) => !fields.has(key));
    if (unknown.length) return json(res, 400, { ok: false, error: `不认识的设置项：${unknown.join(', ')}` });
    const plainPatch = {};
    const secretPatch = {};
    for (const [key, raw] of Object.entries(input)) {
      const field = fields.get(key);
      if (field.type === 'secret') {
        if (raw === null || raw === undefined) continue;
        secretPatch[key] = String(raw);
        continue;
      }
      if (field.type === 'boolean') {
        if (typeof raw !== 'boolean') return json(res, 400, { ok: false, error: `${field.label} 必须是 true/false` });
        plainPatch[key] = raw;
      } else if (field.type === 'number') {
        const value = Number(raw);
        if (!Number.isFinite(value)) return json(res, 400, { ok: false, error: `${field.label} 必须是数字` });
        if (field.min !== undefined && value < field.min) return json(res, 400, { ok: false, error: `${field.label} 不能小于 ${field.min}` });
        if (field.max !== undefined && value > field.max) return json(res, 400, { ok: false, error: `${field.label} 不能大于 ${field.max}` });
        plainPatch[key] = value;
      } else if (field.type === 'select') {
        const value = String(raw);
        if (!(field.options || []).some((option) => option.value === value)) {
          return json(res, 400, { ok: false, error: `${field.label} 的取值不在选项里` });
        }
        plainPatch[key] = value;
      } else {
        const value = String(raw ?? '');
        if (value.length > 4000) return json(res, 400, { ok: false, error: `${field.label} 太长（上限 4000 字）` });
        plainPatch[key] = value;
      }
    }
    try {
      if (Object.keys(plainPatch).length) {
        updateConfig({ plugins: { settings: { [id]: plainPatch } } });
      }
      if (Object.keys(secretPatch).length) {
        writePluginSecrets(dataDir, id, secretPatch, secretFieldKeys(schema));
      }
    } catch (error) {
      return pluginError(res, error, 400);
    }
    // 保存后立刻重载插件：普通设置是进程 init 快照，不重载要等懒启动空闲回收才生效
    //（最长 15 分钟）。重载失败不让保存报错 —— 配置已经写进去了，重载可以在控制台手动再来。
    let reloaded = true;
    try { await pluginRegistry.reload(id); } catch { reloaded = false; }
    auditWrite('plugins.settings', `plugins:${id}`, {
      req,
      fields: Object.keys(plainPatch),
      secrets: Object.keys(secretPatch),
      reloaded
    });
    return json(res, 200, {
      ok: true,
      reloaded,
      values: plainPatch,
      secrets: pluginSecretStatus(dataDir, id, secretFieldKeys(schema))
    });
  });

  // 对象级批准：批准/拒绝的是**一条待批请求**（绑定动作+目标），不再是"类别通行证"。
  router.add('POST', '/api/plugins/approval', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    if (!pluginIdValid(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    const entry = pluginEntryOf(id);
    if (!entry) return json(res, 404, { ok: false, error: '这个插件没有安装' });
    const pendingId = String(body.pendingId || '').trim();
    if (!pendingId) return json(res, 400, { ok: false, error: '缺少待批请求编号（pendingId）' });
    // 待批编号必须属于 URL 里的插件：否则可以借 A 插件的请求批准 B 插件的动作，
    // 审计还会记在 A 名下（2026-10-24 审查 P2）。
    const pendingHit = listPendingApprovals(dataDir).find((item) => item.id === pendingId);
    if (!pendingHit) return json(res, 404, { ok: false, error: '这条待批请求不存在或已过期' });
    if (pendingHit.pluginId !== id) return json(res, 400, { ok: false, error: '这条待批请求属于另一个插件' });
    // 安全接口显式白名单：以前只有 reject 被识别，拼错/漏传 decision 会被当成批准（fail-open）。
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      return json(res, 400, { ok: false, error: 'decision 只能是 approve 或 reject' });
    }
    try {
      if (body.decision === 'reject') {
        const rejected = rejectPendingApproval(dataDir, pendingId);
        auditWrite('plugins.approval.reject', `plugins:${id}:${rejected.action}`, { req, target: rejected.target });
        return json(res, 200, {
          ok: true,
          rejected: { action: rejected.action, target: rejected.target },
          pending: listPendingApprovals(dataDir).filter((item) => item.pluginId === id)
        });
      }
      const uses = Math.max(1, Math.min(100, Math.floor(Number(body.uses) || 1)));
      const ttlMinutes = Math.max(1, Math.min(24 * 60, Math.floor(Number(body.ttlMinutes) || 10)));
      const { grant, pending: hit } = approvePendingApproval(dataDir, pendingId, {
        uses, ttlMs: ttlMinutes * 60_000
      });
      auditWrite('plugins.approval', `plugins:${id}:${hit.action}`, { req, target: hit.target, uses, ttlMinutes });
      // P1：批准后自动重放原调用（只一次；目标/manifest 变化会在 retryApproved 里跳过）
      const retry = hit.retry?.tool ? await pluginRegistry.retryApproved(hit) : null;
      return json(res, 200, {
        ok: true,
        grant,
        retry,
        pending: listPendingApprovals(dataDir).filter((item) => item.pluginId === id),
        grants: grantsStatus(dataDir, id, entry.manifest || {})
      });
    } catch (error) {
      return pluginError(res, error, 400);
    }
  });

  // 全局待批计数（侧栏红点）：所有插件未批写操作请求的总数
  router.add('GET', '/api/plugins/pending-count', async (_req, res) => {
    try {
      const list = listPendingApprovals(dataDir);
      return json(res, 200, { ok: true, count: list.length });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // 全量待批列表：侧栏徽标/顶部提示用它一次看全（跨插件）。
  // 与逐插件详情里的 pending 同一份数据；不含凭据，只有动作、目标、预览与通知状态。
  router.add('GET', '/api/plugins/pending', async (_req, res) => {
    try {
      const pending = listPendingApprovals(dataDir)
        .map((item) => ({
          id: item.id,
          pluginId: item.pluginId,
          pluginName: item.pluginName || item.pluginId,
          action: item.action,
          label: item.label || item.action,
          target: item.target || '',
          preview: String(item.preview || '').slice(0, 300),
          previewLength: Number(item.previewLength) || 0,
          createdAt: Number(item.createdAt) || 0,
          expiresAt: Number(item.expiresAt) || 0,
          notify: item.notify && typeof item.notify === 'object'
            ? { ok: item.notify.ok === true, error: String(item.notify.error || ''), at: Number(item.notify.at) || 0 }
            : null
        }))
        .sort((a, b) => a.expiresAt - b.expiresAt);
      return json(res, 200, { ok: true, pending });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // 应用层自检（"检测登录"按钮）：懒启动的插件会顺手把进程带起来
  router.add('POST', '/api/plugins/probe', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    if (!pluginIdValid(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    try {
      const result = await pluginRegistry.probePlugin(id);
      return json(res, 200, result);
    } catch (error) {
      return pluginError(res, error, 500);
    }
  });

  // 控制台直调插件的**登录类**工具（扫码登录/查结果）：不是给任意工具开的通用后门。
  // 白名单只放 login 的四个 action，且 channel 必须是 console —— 登录不是第三方插件的业务工具，
  // 是宿主替管理员跑的账号操作，所以这里不等同于"模型调用路径"。
  const CONSOLE_PLUGIN_TOOLS = new Set(['login']);
  router.add('POST', '/api/plugins/call', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    if (!pluginIdValid(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    const tool = String(body.tool || '').trim();
    if (!CONSOLE_PLUGIN_TOOLS.has(tool)) return json(res, 403, { ok: false, error: '控制台只允许调用登录类工具' });
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
    if (tool === 'login') {
      const allowedActions = new Set(['start', 'poll', 'status', 'logout']);
      if (!allowedActions.has(String(args.action || ''))) {
        return json(res, 400, { ok: false, error: 'action 只能是 start/poll/status/logout' });
      }
      if (args.channel && args.channel !== 'console') {
        return json(res, 400, { ok: false, error: '控制台只允许 channel=console' });
      }
    }
    try {
      const result = await pluginRegistry.callConsoleTool(id, tool, args);
      return json(res, 200, result);
    } catch (error) {
      return pluginError(res, error, 400);
    }
  });

  // 写动作开关：默认关；开着工具才会注册给模型
  router.add('POST', '/api/plugins/write-switch', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    if (!pluginIdValid(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    const entry = pluginEntryOf(id);
    if (!entry) return json(res, 404, { ok: false, error: '这个插件没有安装' });
    const action = String(body.action || '').trim();
    if (!(entry.manifest?.approvals || []).some((item) => item.action === action)) {
      return json(res, 400, { ok: false, error: '这个动作没有在插件 manifest 里声明' });
    }
    // 深合并不删键，也不解包"新子树里"的 __replace__（父键不存在时整段照抄）——
    // 所以这里在 switches 这一层整体替换：手工拼好全量映射再 __replace__。
    const current = getConfig().plugins?.switches || {};
    const byPlugin = { ...(current[id] || {}) };
    if (body.enabled === true) byPlugin[action] = true;
    else delete byPlugin[action];
    const next = { ...current, [id]: byPlugin };
    updateConfig({ plugins: { switches: { __replace__: next } } });
    await pluginRegistry.reconfigure().catch(() => {});
    auditWrite('plugins.write-switch', `plugins:${id}:${action}`, { req, enabled: body.enabled === true });
    return json(res, 200, { ok: true, switches: byPlugin });
  });

  router.add('POST', '/api/plugins/secrets/clear', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    if (!pluginIdValid(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    clearPluginSecrets(dataDir, id);
    auditWrite('plugins.secrets.clear', `plugins:${id}`, { req });
    return json(res, 200, { ok: true });
  });

  router.add('GET', '/api/plugins/index', async (_req, res) => {
    try {
      const index = await loadIndex();
      return json(res, 200, {
        ok: true,
        // 条目分两类：compatible=true 能装；false 的照样列出来并带原因（"看得见但装不了"比"看不见"好排查）
        plugins: index.plugins,
        // 跳过的条目与拉取失败的来源都如实回报，页面上能看见"少了一条/少了整个索引"
        skipped: index.skipped,
        sources: index.sources
      });
    } catch (error) { return pluginError(res, error, 502); }
  });

  router.add('POST', '/api/plugins/master', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      updateConfig({ plugins: { enabled: body.enabled === true } });
      // 启用前先尽力拿一次撤回名单：否则在索引还没加载过时点开总开关，被撤回的插件会先跑起来
      if (body.enabled === true) await loadIndex({ applyRevocation: false }).catch(() => null);
      await pluginRegistry.reconfigure();
      auditWrite('plugins.master', 'plugins.enabled', { req, enabled: body.enabled === true });
      return json(res, 200, { ok: true, ...pluginRegistry.list() });
    } catch (error) { return pluginError(res, error); }
  });

  router.add('POST', '/api/plugins/toggle', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    try {
      const current = Array.isArray(getConfig().plugins?.enabledIds) ? getConfig().plugins.enabledIds : [];
      const next = body.enabled === true
        ? [...new Set([...current, id])]
        : current.filter((value) => value !== id);
      // enabledIds 是**数组**：deepMerge 对数组本来就是整体替换（不需要 __replace__）；
      // 反过来说 { __replace__: [...] } 会被静默忽略（那个约定只认对象）—— 那样"启用"就永远写不进去
      updateConfig({ plugins: { enabledIds: next } });
      // 单独启一个插件时把总开关一起打开：否则用户点了"启用"却什么都没发生（默认全关）
      if (body.enabled === true && getConfig().plugins?.enabled !== true) {
        updateConfig({ plugins: { enabled: true } });
      }
      // 启用前先尽力拿一次撤回名单：索引还没加载过就点启用时，被撤回的插件会先跑起来
      if (body.enabled === true) await loadIndex({ applyRevocation: false }).catch(() => null);
      await pluginRegistry.reconfigure();
      auditWrite('plugins.toggle', `plugins:${id}`, { req, enabled: body.enabled === true });
      return json(res, 200, { ok: true, enabledIds: next, ...pluginRegistry.list() });
    } catch (error) { return pluginError(res, error); }
  });

  router.add('POST', '/api/plugins/reload', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    try {
      const result = await pluginRegistry.reload(id);
      if (!result.ok) return json(res, 400, { ok: false, error: result.error || '重载失败' });
      return json(res, 200, { ok: true, running: result.running === true, ...pluginRegistry.list() });
    } catch (error) { return pluginError(res, error); }
  });

  // 升级预览：只下载/解包/比对，不换目录、不停旧进程。
  // 权限面有变化时必须先看 diff，再带 expectedDiffHash 安装（fail-closed）。
  router.add('POST', '/api/plugins/upgrade-preview', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    if (!pluginIdValid(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    try {
      const hit = (await loadIndex()).plugins.find((item) => item.id === id);
      if (!hit) return json(res, 404, { ok: false, error: `索引里没有 ${id}` });
      if (hit.compatible === false) return json(res, 409, { ok: false, error: `这个插件在本机装不了：${hit.reason}` });
      if (!hit.url || !hit.sha256) return json(res, 400, { ok: false, error: '索引条目缺少下载地址或 sha256' });
      const mirrorConfig = getMirrorConfig();
      const download = async (target, maxBytes) => {
        const picked = await fetchBinaryWithMirrors({
          url: target, mirrors: Array.isArray(hit.mirrors) ? hit.mirrors : [], prefixes: mirrorConfig.prefixes,
          maxBytes, fetchImpl: (u, mb) => safeFetchBinary(u, mb, undefined, { allowPrivate: false }), log: pluginLog,
          verify: (buffer) => sha256Of(buffer) === String(hit.sha256 || '').toLowerCase()
        });
        if (!picked.ok) throw Object.assign(new Error(picked.error), { code: 'E_DOWNLOAD' });
        return { buffer: picked.buffer };
      };
      const result = await installPlugin({
        id, url: hit.url, sha256: hit.sha256, publisher: hit.publisher || '', signature: hit.signature || '',
        publishers: getConfig().plugins?.publishers || {},
        indexMeta: hit,
        dataDir: dataDir, fetchBinary: download, log: pluginLog, previewOnly: true
      });
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, 400, { ok: false, code: error?.code || '', error: String(error?.message || error) });
    }
  });

  router.add('POST', '/api/plugins/install', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    // 在 try 的第一句声明：catch 里要用它，而 let 在 TDZ 里连 typeof 都会抛
    let replaced = false;
    try {
      const id = String(body.id || '').trim();
      let url = String(body.url || '').trim();
      let sha256 = String(body.sha256 || '').trim();
      let source = String(body.source || '').trim();
      let publisher = '';
      let signature = '';
      let hitMirrors = [];
      let hitMeta = null;
      if (!url) {
        if (!id) return json(res, 400, { ok: false, error: '要么给索引里的 id，要么给 url + sha256' });
        const hit = (await loadIndex()).plugins.find((item) => item.id === id);
        if (!hit) return json(res, 404, { ok: false, error: `索引里没有 ${id}` });
        hitMeta = hit;
        if (hit.compatible === false) {
          // 装上去也跑不起来（apiVersion / minVersion 对不上）—— 在动手之前就拦住，并说清原因
          return json(res, 409, { ok: false, error: `这个插件在本机装不了：${hit.reason}` });
        }
        // 以索引为准取地址、校验和与签名（不信请求体里那份，索引是唯一真源）
        url = hit.url;
        sha256 = hit.sha256;
        publisher = hit.publisher || '';
        signature = hit.signature || '';
        hitMirrors = Array.isArray(hit.mirrors) ? hit.mirrors : [];
        source = `索引：${hit.source || '未命名'}`;
      } else if (!source) {
        source = '手动填写的地址';
      }
      const mirrorConfig = getMirrorConfig();
      const download = async (target, maxBytes) => {
        const picked = await fetchBinaryWithMirrors({
          url: target, mirrors: hitMirrors, prefixes: mirrorConfig.prefixes,
          maxBytes, fetchImpl: (u, mb) => safeFetchBinary(u, mb, undefined, { allowPrivate: false }), log: pluginLog,
          // sha256 校验放进候选循环：镜像回 200 + 错误页/旧包时，只有这里能继续试下一条；
          // 拖到换入前才校验的话，坏候选已经被记成"这条通"，之后每次都先走它
          verify: (buffer) => sha256Of(buffer) === String(sha256 || '').toLowerCase()
        });
        if (!picked.ok) throw Object.assign(new Error(picked.error), { code: 'E_DOWNLOAD' });
        return { buffer: picked.buffer };
      };
      // 只有真的走到"换入前"才代表旧进程被停过；下载/验签/解包失败时不必重排（重排会停掉
      // 其它插件的进程、打断它们正在进行的工具调用）
      const result = await installPlugin({
        id, url, sha256, source, hostVersion: hostVersion, publisher, signature,
        // 发布者公钥来自本机配置（不是索引 —— 索引给自己签名等于没签）
        publishers: getConfig().plugins?.publishers || {},
        dataDir: dataDir, fetchBinary: download, log: pluginLog,
        // 权限面变化时，管理员先在预览里确认；这里校验确认哈希，防止"确认的是旧 diff"
        expectedDiffHash: String(body.expectedDiffHash || ''),
        force: body.force === true,
        // 索引是唯一真源：安装时用它核对"包实际声明的权限"有没有超出索引展示的范围
        indexMeta: hitMeta,
        allowIndexMismatch: body.allowIndexMismatch === true,
        // 升级时先停掉旧进程再换目录（Windows 上 rename 存活进程的 cwd 会失败）
        beforeReplace: (pluginId) => { replaced = true; return pluginRegistry.stopOne(pluginId); }
      });
      auditWrite('plugins.install', `plugins:${result.id}`, { req, version: result.version, upgraded: result.upgraded });
      // 权限面变了：清对象级批准/待批，并关闭所有写动作开关（保留配额计数，防止用升级刷额度）
      if (result.upgraded && result.diff?.permissionChanged) {
        const reset = resetPluginGrants(dataDir, result.id);
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugins', result.id, 'plugin.json'), 'utf8'));
          const actions = (Array.isArray(manifest.approvals) ? manifest.approvals : [])
            .map((item) => String(item.action || '')).filter(Boolean);
          if (actions.length) {
            updateConfig({
              plugins: { switches: { [result.id]: Object.fromEntries(actions.map((action) => [action, false])) } }
            });
          }
        } catch (error) {
          log(`[plugins] 升级后关闭写开关失败（相关授权已清空）：${error?.message ?? error}`);
        }
        auditWrite('plugins.upgrade', `plugins:${result.id}`, {
          req, version: result.version, areas: result.diff.areas, summary: result.diff.summary, reset
        });
      }
      // 装完重排一次：让控制台立刻看到新插件（默认未授权，不会自动跑）
      await pluginRegistry.reconfigure();
      return json(res, 200, { ok: true, ...result, ...pluginRegistry.list() });
    } catch (error) {
      // 上面为了能换目录才停旧进程：只有真的动过目录失败时才需要按原配置放回去。
      // 下载超时/sha 不符这类失败发生在换入之前，此时重排纯属误伤（会打断其它插件在途的工具调用）
      if (replaced) await pluginRegistry.reconfigure().catch(() => {});
      // 指纹不符时先怀疑"索引是旧的"：目录缓存 10 分钟，而发布方（或用户自己）可能刚更新过索引 ——
      // 这时包没错、是索引旧了，回一句"校验失败"会让人以为包坏了。清掉缓存让下次读到新的，并把话说明白。
      //（2026-10-16 实测：索引仓库刚推上去，服务器侧装的还是旧索引，install 就这么失败了。）
      if (error?.code === 'E_SHA_MISMATCH') {
        // 清成空壳：key='' 让下一次必然重拉；旧 result 留着也没人读（读的是 key 匹配的那份），
        // 保留它只会让人以为"旧数据还有用"
        invalidateIndex();
        return json(res, 409, {
          ok: false,
          code: error.code,
          error: `${error.message}。目录可能刚更新过（控制台手里的目录最多旧 10 分钟）—— 已刷新，再点一次安装即可。`
        });
      }
      if (['E_UPGRADE_CONFIRM', 'E_UPGRADE_CONFIRM_STALE', 'E_DOWNGRADE', 'E_SAME_VERSION', 'E_INDEX_MISMATCH'].includes(error?.code)) {
        return json(res, 409, {
          ok: false, code: error.code, error: error.message, diff: error.diff || null
        });
      }
      return pluginError(res, error);
    }
  });

  router.add('POST', '/api/plugins/install-file', async (req, res) => {
    // "别人发我一个包 / 我自己打了一个包"的最短路径。走 JSON + base64 是为了复用同一条请求体读取
    // 与错误通道（body 上限单独放宽到 8MB —— 插件包本身限 5MB，base64 膨胀约 1/3）。
    // 本地文件安装的 sha256 是**算出来给用户核对**的，不是要用户提供：内容就是身份。
    const body = await readBody(req, 8 * 1024 * 1024).catch((error) => {
      if (Number(error?.httpStatus) === 413) return { __tooLarge: true };
      return {};
    });
    if (body?.__tooLarge) {
      return json(res, 413, { ok: false, error: `文件太大：插件包上限 ${MAX_PLUGIN_ARCHIVE_BYTES / 1024 / 1024}MB` });
    }
    let replaced = false;
    try {
      const encoded = String(body.base64 || '');
      if (!encoded) return json(res, 400, { ok: false, error: '没有收到文件内容' });
      const buffer = Buffer.from(encoded, 'base64');
      if (!buffer.length) return json(res, 400, { ok: false, error: '文件内容解不出来（不是合法的 base64？）' });
      const fileName = path.basename(String(body.fileName || 'package.tar.gz')).slice(0, 120) || 'package.tar.gz';
      const result = await installPlugin({
        tarball: buffer, dataDir: dataDir, hostVersion: hostVersion,
        source: `本地文件：${fileName}`,
        publishers: getConfig().plugins?.publishers || {},
        // 本地包也可能在升级一个正在跑的插件；权限面变化时与其他安装入口同一道确认门槛。
        // 调用方可以先不带哈希、拿 409 里的 diff.diffHash 带回来重试。
        expectedDiffHash: String(body.expectedDiffHash || '').trim(),
        // 同上：本地包也可能是在升级一个正在跑的插件
        beforeReplace: (pluginId) => { replaced = true; return pluginRegistry.stopOne(pluginId); },
        log: pluginLog
      });
      auditWrite('plugins.install-file', `plugins:${result.id}`, { req, version: result.version, upgraded: result.upgraded, fileName });
      await pluginRegistry.reconfigure();
      return json(res, 200, { ok: true, ...result, sha256: sha256Of(buffer), fileName, ...pluginRegistry.list() });
    } catch (error) {
      // 换入阶段失败时旧进程已被停掉：按原配置放回去（更早的失败没停过任何进程，不重排）
      if (replaced) await pluginRegistry.reconfigure().catch(() => {});
      if (['E_UPGRADE_CONFIRM', 'E_UPGRADE_CONFIRM_STALE'].includes(error?.code)) {
        return json(res, 409, {
          ok: false, code: error.code, error: error.message, diff: error.diff || null
        });
      }
      return pluginError(res, error);
    }
  });

  router.add('POST', '/api/plugins/rollback', async (req, res) => {
    // 升级后悔药：回退到上一次升级前的版本（备份是升级时自动留的，见 install.js）
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '').trim();
    try {
      await pluginRegistry.stopOne(id);       // 先收进程再换目录（Windows 上不能 rename 存活进程的 cwd）
      const result = rollbackPlugin({ id, dataDir: dataDir, log: pluginLog });
      auditWrite('plugins.rollback', `plugins:${id}`, { req, version: result.version });
      await pluginRegistry.reconfigure();
      return json(res, 200, { ok: true, ...result, ...pluginRegistry.list() });
    } catch (error) {
      // 回退失败时**也要**重排一次：stopOne 已经把进程收掉了，不重排的话这个插件会一直停在
      // "已停"直到下次配置变更或重启 —— 用户只看到一条"回退失败"，不知道插件被一并停掉了
      await pluginRegistry.reconfigure().catch(() => {});
      return pluginError(res, error);
    }
  });

  router.add('POST', '/api/plugins/uninstall', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    // 破坏性操作统一 confirm 门槛（与全站口径一致）
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '卸载插件需要 body.confirm === true' });
    const id = String(body.id || '').trim();
    if (!pluginIdValid(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
    try {
      // 先停掉这个插件的进程再挪目录：子进程的 cwd 就是插件目录，Windows 上"作为存活进程 cwd 的
      // 目录"不能被 rename（EPERM/EBUSY），会出现"点卸载报错、插件还在"。Linux 上虽然能挪，
      // 但让一个已卸载插件的进程继续跑也没有道理。
      await pluginRegistry.stopOne(id);
      // 卸载 = 这个安装实例结束：enabledIds/动作开关、对象级批准、凭据、待批与备份都不能
      // 留给同 id 的下一个包（2026-10 审查 P1）。配置先改，避免卸载后重装即自动运行。
      const plugins = getConfig().plugins || {};
      const enabledIds = (Array.isArray(plugins.enabledIds) ? plugins.enabledIds : [])
        .filter((value) => value !== id);
      const switches = { ...(plugins.switches || {}) };
      delete switches[id];
      const purgeData = body?.purgeData === true;
      const nextPlugins = { enabledIds, switches: { __replace__: switches } };
      if (purgeData) {
        const settings = { ...(plugins.settings || {}) };
        delete settings[id];
        nextPlugins.settings = { __replace__: settings };
      }
      updateConfig({ plugins: nextPlugins });
      const result = uninstallPlugin({ id, dataDir: dataDir, purgeData });
      clearPluginGrants(dataDir, id);
      clearPluginSecrets(dataDir, id);
      auditWrite('plugins.uninstall', `plugins:${id}`, { req, purgeData, dataPurged: result.dataPurged });
      await pluginRegistry.reconfigure();
      return json(res, 200, { ok: true, ...result, ...pluginRegistry.list() });
    } catch (error) {
      // stopOne 已经把进程收掉了：卸载失败（Windows 上目录被占用等）时按原配置放回去，
      // 否则插件会一直停在"已停"直到下次配置变更或重启（与 rollback 的 catch 同口径）
      await pluginRegistry.reconfigure().catch(() => {});
      return pluginError(res, error);
    }
  });

}
