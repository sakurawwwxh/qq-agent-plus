// 插件 manifest（plugin.json）的解析与校验 —— **fail-closed**：任一项不合法就拒载并给出
// 可读原因，不做"尽力而为"的宽容解析。插件是第三方代码，宽容解析等于把边界交给对方。
//
// 契约（apiVersion 1/2，见 docs/PLUGINS.md）：
//   {
//     "id": "weather",                       // 小写字母数字与连字符，2-32 位
//     "apiVersion": 2,
//     "name": "Minecraft 服务器状态",          // 给人看的名字
//     "version": "1.0.0",
//     "description": "一句话说明（可选）",
//     "entry": "index.mjs",                  // 可选，默认 index.mjs；必须落在插件目录内
//     "capabilities": ["tools", "http"],     // 声明式：宿主只按这份清单注入能力
//     "tools": [ { "name": "mc_status", "description": "…", "parameters": {…} } ],
//     "schedule": [ { "name": "poll", "everyMs": 300000 } ],
//     "settings": { "groups": [...] },       // v2：宿主统一渲染的设置面板
//     "httpDomains": ["api.example.com"],     // v2：http 只允许这些域名（含子域）
//     "approvals": [ { "action": "like", "label": "点赞" } ],  // v2：需要 owner 授权的动作
//     "quotas": { "like": 20 }               // v2：每个动作每天的上限
//   }
//
// ⚠️ 这里的每一条限制都对应一个真实的失败模式：id 会进工具名前缀（撞名/注入）、entry 会进
// 文件系统路径（目录穿越）、tool 描述会进提示词（提示注入面）、everyMs 会变成定时器（0 或
// 负数 = 空转烧 CPU）。校验失败一律返回 `{ ok:false, error }`，由调用方决定怎么报。
import path from 'node:path';
import { secretFieldKeys } from './secrets.js';

export const PLUGIN_API_VERSION = 2;

/** 兼容的 manifest 版本。加载时会把这组版本一起告诉插件（plugins 可以按 version 分支）。 */
export const SUPPORTED_API_VERSIONS = Object.freeze([1, 2]);

/** v1 能力白名单。加能力 = 加一条宿主侧实现 + 这里补一个名字（`send` 刻意不在 v1 里）。 */
export const PLUGIN_CAPABILITIES = Object.freeze([
  'tools',      // 把 manifest 里声明的工具暴露给模型（只读）
  'observe',    // 收到入站消息（只读，不能改内容、不能拦消息）
  'schedule',   // 按 manifest 声明的周期跑任务
  'http',       // 经宿主发 HTTP（走 safe-fetch 的守卫，便于审计；**不是**安全边界，见 docs/PLUGINS.md）
  'log',        // 经宿主写日志（带插件前缀 + 脱敏）
  'storage',    // 经宿主读写自己那点状态（宿主侧落盘，插件进程没有写权限）
  'config',     // 读自己那段配置（plugins.settings.<id>）
  'send',       // **代机器人发言**（走宿主的发送队列：非活跃时间、观察/暂停模式、群白名单、
                //  禁言预检、限频、outbox 记账全都在里面）。信任面最大的一条，界面上会明确标出来
  // ── v2 ──
  'secrets',    // 加密存储的凭据（Cookie / Token）；只允许 manifest.settings 里声明为 secret 的字段
  'approval',   // 高风险动作的 owner 授权（控制台按 approvals 清单批准，可按次/按时长）
  'media',      // 宿主侧下载 / ffprobe / ffmpeg 合流（插件不执行命令）
  'quota',      // 宿主按插件/动作/天强制配额
  'feed'        // 向生活层提交"见闻候选"（不能调模型、不能发消息；宿主决定要不要用）
]);

export const V2_CAPABILITIES = Object.freeze(['secrets', 'approval', 'media', 'quota', 'feed']);

const FIELD_TYPES = Object.freeze(['text', 'number', 'boolean', 'select', 'secret']);
const KEY_RE = /^[a-z][A-Za-z0-9_]{0,31}$/;
const ACTION_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_GROUPS = 8;
const MAX_FIELDS = 32;
const MAX_OPTIONS = 20;
const MAX_ACTIONS = 24;
const MAX_SCHEDULES = 24;
const MAX_DOMAIN = 120;

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
// plugin-grants/pending.json 是全局待批队列；插件 id 撞上它会把旧队列覆盖成对象/数组，
// 导致所有插件的待批请求静默消失（2026-10 审查 P2）。
const RESERVED_IDS = new Set(['pending']);
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,31}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_TOOLS = 12;
const MAX_DESCRIPTION = 300;
const MAX_TOOL_DESCRIPTION = 900;
const MIN_EVERY_MS = 60 * 1000;                 // 低于一分钟的周期任务没有意义，只会烧 CPU
const MAX_EVERY_MS = 7 * 24 * 3600 * 1000;

// 单个工具的入参 schema 上限：属性数与序列化字节数（见 validateTool 注释）
const MAX_TOOL_PROPERTIES = 64;
const MAX_TOOL_SCHEMA_BYTES = 16 * 1024;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** 校验声明式工具的入参 schema：只认 OpenAI 那套 JSON Schema 形状的最小子集。 */
function validateTool(raw, index) {
  const where = `tools[${index}]`;
  if (!isPlainObject(raw)) return { error: `${where} 必须是对象` };
  const name = str(raw.name);
  if (!TOOL_NAME_RE.test(name)) {
    return { error: `${where}.name 只能是小写字母开头的字母/数字/下划线（2-32 位），实际 ${JSON.stringify(raw.name)}` };
  }
  const description = str(raw.description);
  if (!description) return { error: `${where}.description 不能为空（模型靠它决定要不要调用）` };
  if (description.length > MAX_TOOL_DESCRIPTION) return { error: `${where}.description 太长（上限 ${MAX_TOOL_DESCRIPTION} 字）` };
  const parameters = raw.parameters ?? { type: 'object', properties: {} };
  if (!isPlainObject(parameters) || parameters.type !== 'object') {
    return { error: `${where}.parameters 必须是 {"type":"object",…} 形状` };
  }
  if (parameters.properties !== undefined && !isPlainObject(parameters.properties)) {
    return { error: `${where}.parameters.properties 必须是对象` };
  }
  if (parameters.required !== undefined
    && (!Array.isArray(parameters.required) || parameters.required.some((k) => typeof k !== 'string'))) {
    return { error: `${where}.parameters.required 必须是字符串数组` };
  }
  // schema 会原样进每一轮模型请求（direct 模式）或拼进 plugin_call 的描述（meta 模式）。
  // 不设上限时，一个 5MB 内的包可以塞两万个属性，让之后**每一次**请求都超长被拒 ——
  // 整个机器人静默停摆到有人禁用插件为止（2026-10-17 审查 P2）。
  const propertyCount = Object.keys(parameters.properties || {}).length;
  if (propertyCount > MAX_TOOL_PROPERTIES) {
    return { error: `${where}.parameters.properties 太多（${propertyCount} 个，上限 ${MAX_TOOL_PROPERTIES}）` };
  }
  const requiredCount = Array.isArray(parameters.required) ? parameters.required.length : 0;
  if (requiredCount > MAX_TOOL_PROPERTIES) {
    return { error: `${where}.parameters.required 太多（${requiredCount} 个，上限 ${MAX_TOOL_PROPERTIES}）` };
  }
  let serialized = '';
  try { serialized = JSON.stringify(parameters); } catch { return { error: `${where} 不能序列化` }; }
  if (serialized.length > MAX_TOOL_SCHEMA_BYTES) {
    return { error: `${where}.parameters 太大（${serialized.length} 字节，上限 ${MAX_TOOL_SCHEMA_BYTES}）` };
  }
  // 工具级超时（v2）：慢工具（媒体下载/转码）不该被全局 20s 一刀切，
  // 但也不能让一个工具把会话挂满十分钟。1s–300s，超出按边界夹住。
  const timeoutMs = Number(raw.timeoutMs);
  const tool = { name, description, parameters };
  if (Number.isFinite(timeoutMs) && raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
    tool.timeoutMs = Math.max(1000, Math.min(300000, Math.round(timeoutMs)));
  }
  // 写操作声明（v2.1）：这个工具执行哪个动作（必须出现在 approvals 里）、
  // 目标与预览取自哪个参数。宿主据此在调插件**之前**做"开关→对象级批准→配额"三层拦截。
  const action = str(raw.action);
  if (action) {
    if (!ACTION_RE.test(action)) return { error: `${where}.action 只能是小写字母开头的字母/数字/下划线` };
    tool.action = action;
    // actionTarget 接受单个参数名或数组（interact 这类工具的目标可能在 bvid 或 mid 上），
    // 宿主按顺序取第一个非空值当批准要绑定的目标。
    const targetRaw = raw.actionTarget;
    if (targetRaw !== undefined && targetRaw !== null && String(targetRaw).trim() !== '') {
      const list = Array.isArray(targetRaw) ? targetRaw : [targetRaw];
      if (list.length > 4 || list.some((name) => !KEY_RE.test(str(name)))) {
        return { error: `${where}.actionTarget 只能是参数名或参数名数组（≤4 个）` };
      }
      tool.actionTarget = list.map((name) => str(name));
    }
    const previewValue = str(raw.actionPreview);
    if (previewValue) {
      if (!KEY_RE.test(previewValue)) return { error: `${where}.actionPreview 只能是参数名（字母/数字/下划线）` };
      tool.actionPreview = previewValue;
    }
  }
  return { tool };
}

/** 宿主版本要求：v2.1 的 engines.minVersion，安装时与每次加载时都校验。 */
function validateEngines(raw) {
  if (raw === undefined || raw === null) return { engines: null };
  if (!isPlainObject(raw)) return { error: 'engines 必须是对象（如 {"minVersion":"0.9.6"}）' };
  const minVersion = str(raw.minVersion);
  if (minVersion && !SEMVER_RE.test(minVersion)) {
    return { error: `engines.minVersion 必须是 x.y.z 形式，实际 ${JSON.stringify(raw.minVersion)}` };
  }
  return { engines: minVersion ? { minVersion } : null };
}

/** 校验周期任务：宿主侧起定时器，所以周期必须有硬下限，免得插件把机器人空转死。 */
function validateSchedule(raw, index) {
  const where = `schedule[${index}]`;
  if (!isPlainObject(raw)) return { error: `${where} 必须是对象` };
  const name = str(raw.name);
  if (!TOOL_NAME_RE.test(name)) return { error: `${where}.name 只能是小写字母开头的字母/数字/下划线（2-32 位）` };
  const everyMs = Number(raw.everyMs);
  if (!Number.isFinite(everyMs) || everyMs < MIN_EVERY_MS || everyMs > MAX_EVERY_MS) {
    return { error: `${where}.everyMs 必须是 ${MIN_EVERY_MS / 60000} 分钟到 7 天之间的毫秒数，实际 ${JSON.stringify(raw.everyMs)}` };
  }
  return { schedule: { name, everyMs } };
}

/** v2 设置 schema：宿主统一渲染，插件作者不写 HTML/JS。 */
function validateSettings(raw) {
  if (raw === undefined) return { settings: null };
  if (!isPlainObject(raw)) return { error: 'settings 必须是对象' };
  const groups = raw.groups ?? [];
  if (!Array.isArray(groups) || groups.length > MAX_GROUPS) {
    return { error: `settings.groups 必须是数组且不超过 ${MAX_GROUPS} 组` };
  }
  let fieldCount = 0;
  const seenKeys = new Set();
  const out = [];
  for (const [groupIndex, group] of groups.entries()) {
    const where = `settings.groups[${groupIndex}]`;
    if (!isPlainObject(group)) return { error: `${where} 必须是对象` };
    const key = str(group.key) || `group${groupIndex + 1}`;
    if (!KEY_RE.test(key)) return { error: `${where}.key 只能是小写字母开头的字母/数字/下划线` };
    const title = str(group.title);
    if (!title) return { error: `${where}.title 不能为空（设置页的分组标题）` };
    const description = str(group.description).slice(0, MAX_DESCRIPTION);
    const fields = group.fields ?? [];
    if (!Array.isArray(fields)) return { error: `${where}.fields 必须是数组` };
    const cleanFields = [];
    for (const [fieldIndex, field] of fields.entries()) {
      fieldCount += 1;
      if (fieldCount > MAX_FIELDS) return { error: `settings 字段总数超过 ${MAX_FIELDS} 个` };
      const at = `${where}.fields[${fieldIndex}]`;
      if (!isPlainObject(field)) return { error: `${at} 必须是对象` };
      const fieldKey = str(field.key);
      if (!KEY_RE.test(fieldKey)) return { error: `${at}.key 只能是小写字母开头的字母/数字/下划线（≤32 位）` };
      if (seenKeys.has(fieldKey)) return { error: `设置字段 key 重复：${fieldKey}` };
      seenKeys.add(fieldKey);
      const type = str(field.type) || 'text';
      if (!FIELD_TYPES.includes(type)) {
        return { error: `${at}.type 只能是 ${FIELD_TYPES.join(' / ')}，实际 ${JSON.stringify(field.type)}` };
      }
      const label = str(field.label);
      if (!label) return { error: `${at}.label 不能为空` };
      if (label.length > 80) return { error: `${at}.label 太长（上限 80 字）` };
      const clean = {
        key: fieldKey,
        type,
        label,
        help: str(field.help).slice(0, 300),
        required: field.required === true,
        placeholder: str(field.placeholder).slice(0, 120)
      };
      if (type === 'select') {
        const options = Array.isArray(field.options) ? field.options : [];
        if (!options.length || options.length > MAX_OPTIONS) {
          return { error: `${at}.options 必须是 1-${MAX_OPTIONS} 项` };
        }
        clean.options = options.map((option) => {
          if (!isPlainObject(option)) return null;
          const value = str(option.value);
          const optionLabel = str(option.label) || value;
          if (!value || value.length > 64) return null;
          return { value, label: optionLabel.slice(0, 80) };
        });
        if (clean.options.some((option) => !option)) return { error: `${at}.options 里有非法项` };
      }
      if (type === 'number') {
        const min = Number(field.min);
        const max = Number(field.max);
        if (Number.isFinite(min)) clean.min = min;
        if (Number.isFinite(max)) clean.max = max;
      }
      if (field.default !== undefined) {
        const value = field.default;
        const valid = type === 'boolean' ? typeof value === 'boolean'
          : type === 'number' ? Number.isFinite(Number(value))
            : type === 'select' ? clean.options.some((option) => option.value === String(value))
              : typeof value === 'string';
        if (!valid) return { error: `${at}.default 与 type=${type} 不匹配` };
        clean.default = type === 'number' ? Number(value) : value;
      }
      cleanFields.push(clean);
    }
    out.push({ key, title, description, fields: cleanFields });
  }
  return { settings: { groups: out } };
}

/** 需要 owner 授权的动作清单（控制台据此生成"批准一次/10 分钟"按钮）。 */
function validateApprovals(raw) {
  if (raw === undefined) return { approvals: [] };
  const list = Array.isArray(raw) ? raw : null;
  if (!list) return { error: 'approvals 必须是数组' };
  if (list.length > MAX_ACTIONS) return { error: `approvals 超过 ${MAX_ACTIONS} 条` };
  const out = [];
  const seen = new Set();
  for (const [index, item] of list.entries()) {
    const where = `approvals[${index}]`;
    if (!isPlainObject(item)) return { error: `${where} 必须是对象` };
    const action = str(item.action);
    if (!ACTION_RE.test(action)) return { error: `${where}.action 只能是小写字母开头的字母/数字/下划线` };
    if (seen.has(action)) return { error: `approvals 动作重复：${action}` };
    seen.add(action);
    const label = str(item.label);
    if (!label) return { error: `${where}.label 不能为空` };
    out.push({
      action,
      label: label.slice(0, 80),
      description: str(item.description).slice(0, 300),
      defaultUses: Math.max(1, Math.min(100, Number(item.defaultUses) || 1))
    });
  }
  return { approvals: out };
}

/** 每天的动作配额：默认拒绝（没声明的动作不能消费配额）。 */
function validateQuotas(raw, approvals) {
  if (raw === undefined) return { quotas: {} };
  if (!isPlainObject(raw)) return { error: 'quotas 必须是对象（action → 每天上限）' };
  const out = {};
  const known = new Set(approvals.map((item) => item.action));
  for (const [action, value] of Object.entries(raw)) {
    if (!ACTION_RE.test(action)) return { error: `quotas 的动作名不合法：${action}` };
    if (known.size && !known.has(action)) {
      return { error: `quotas.${action} 没有在 approvals 里声明（高风险动作必须先声明）` };
    }
    const limit = Number(value);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 10000) {
      return { error: `quotas.${action} 必须是 1-10000 的整数` };
    }
    out[action] = Math.floor(limit);
  }
  return { quotas: out };
}

/** http 域名白名单：只认主机名，允许列出子域。 */
function validateHttpDomains(raw) {
  if (raw === undefined) return { httpDomains: [] };
  if (!Array.isArray(raw) || raw.length > 32) return { error: 'httpDomains 必须是数组且不超过 32 项' };
  const out = [];
  for (const value of raw) {
    const domain = str(value).toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes('.') || domain.length > MAX_DOMAIN) {
      return { error: `httpDomains 里有非法域名：${JSON.stringify(value)}` };
    }
    if (!out.includes(domain)) out.push(domain);
  }
  return { httpDomains: out };
}

/**
 * 解析并校验一份 manifest。
 * @param raw   plugin.json 的解析结果（对象）
 * @param dir   插件目录的绝对路径（用于校验 entry 不越界）
 * @returns {{ok:true, manifest}|{ok:false, error:string}}
 */
export function parsePluginManifest(raw, { dir = '' } = {}) {
  if (!isPlainObject(raw)) return { ok: false, error: 'manifest 必须是 JSON 对象' };

  const id = str(raw.id);
  if (!ID_RE.test(id)) {
    return { ok: false, error: `id 只能是小写字母/数字/连字符（2-32 位，首字符为字母或数字），实际 ${JSON.stringify(raw.id)}` };
  }
  if (RESERVED_IDS.has(id)) {
    return { ok: false, error: `id「${id}」是宿主保留名，请换一个` };
  }
  if (!SUPPORTED_API_VERSIONS.includes(Number(raw.apiVersion))) {
    return {
      ok: false,
      error: `apiVersion 不匹配：本机支持 ${SUPPORTED_API_VERSIONS.join(' / ')}，插件声明 ${JSON.stringify(raw.apiVersion)}`
    };
  }
  const apiVersion = Number(raw.apiVersion);
  const name = str(raw.name);
  if (!name) return { ok: false, error: 'name 不能为空（控制台与日志里要能认出是哪个插件）' };
  if (name.length > MAX_DESCRIPTION) return { ok: false, error: `name 太长（上限 ${MAX_DESCRIPTION} 字）` };
  const version = str(raw.version);
  if (!SEMVER_RE.test(version)) return { ok: false, error: `version 必须是形如 1.0.0 的版本号，实际 ${JSON.stringify(raw.version)}` };
  const description = str(raw.description);
  if (description.length > MAX_DESCRIPTION) return { ok: false, error: `description 太长（上限 ${MAX_DESCRIPTION} 字）` };

  const capabilities = raw.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return { ok: false, error: 'capabilities 必须是非空数组（哪怕只声明 ["tools"]）' };
  }
  const unknown = capabilities.filter((cap) => !PLUGIN_CAPABILITIES.includes(cap));
  if (unknown.length) {
    return { ok: false, error: `不认识的能力：${unknown.join(' / ')}（可选：${PLUGIN_CAPABILITIES.join(' / ')}）` };
  }
  if (new Set(capabilities).size !== capabilities.length) return { ok: false, error: 'capabilities 里有重复项' };
  if (apiVersion < 2) {
    const v2 = capabilities.filter((cap) => V2_CAPABILITIES.includes(cap));
    if (v2.length) return { ok: false, error: `apiVersion 1 不能声明 ${v2.join(' / ')}（这些能力需要 apiVersion 2）` };
  }

  // entry 必须落在插件目录内：这是唯一一处把 manifest 里的字符串拿去拼路径的地方，
  // 也是目录穿越的唯一入口（`"entry": "../../../etc/passwd"`）。
  const entry = str(raw.entry) || 'index.mjs';
  if (entry.includes('\0')) return { ok: false, error: 'entry 含非法字符' };
  const entryAbs = path.resolve(dir, entry);
  if (dir && entryAbs !== dir && !entryAbs.startsWith(dir + path.sep)) {
    // 不回显 entryAbs：这条错误会一路显示到控制台，绝对路径属于不该漏的服务器细节
    return { ok: false, error: `entry 必须落在插件目录内（收到的是 ${JSON.stringify(raw.entry)}）` };
  }

  const rawTools = raw.tools ?? [];
  if (!Array.isArray(rawTools)) return { ok: false, error: 'tools 必须是数组' };
  if (rawTools.length > MAX_TOOLS) return { ok: false, error: `工具数超过上限 ${MAX_TOOLS} 个（每个工具都会占提示词预算）` };
  if (rawTools.length && !capabilities.includes('tools')) {
    return { ok: false, error: '声明了 tools 就必须在 capabilities 里带上 "tools"' };
  }
  const tools = [];
  for (const [index, item] of rawTools.entries()) {
    const result = validateTool(item, index);
    if (result.error) return { ok: false, error: result.error };
    if (tools.some((t) => t.name === result.tool.name)) return { ok: false, error: `工具名重复：${result.tool.name}` };
    // OpenAI function name 上限 64；`<id>__<tool>` 最长可达 32+2+32=66，严格端点会 400
    // 整轮请求（不只是这个工具不可用）。安装时就拒掉，别让用户运行期才遇到。
    if (qualifiedToolName(id, result.tool.name).length > 64) {
      return {
        ok: false,
        error: `模型侧工具名 ${qualifiedToolName(id, result.tool.name)} 超过 64 字符上限（id 与工具名合计需 ≤62）`
      };
    }
    tools.push(result.tool);
  }

  const rawSchedule = raw.schedule ?? [];
  if (!Array.isArray(rawSchedule)) return { ok: false, error: 'schedule 必须是数组' };
  if (rawSchedule.length > MAX_SCHEDULES) {
    return { ok: false, error: `schedule 超过 ${MAX_SCHEDULES} 条上限` };
  }
  if (rawSchedule.length && !capabilities.includes('schedule')) {
    return { ok: false, error: '声明了 schedule 就必须在 capabilities 里带上 "schedule"' };
  }
  const schedule = [];
  const scheduleNames = new Set();
  for (const [index, item] of rawSchedule.entries()) {
    const result = validateSchedule(item, index);
    if (result.error) return { ok: false, error: result.error };
    if (scheduleNames.has(result.schedule.name)) {
      return { ok: false, error: `周期任务名重复：${result.schedule.name}` };
    }
    scheduleNames.add(result.schedule.name);
    schedule.push(result.schedule);
  }

  let settings = null;
  let approvals = [];
  let quotas = {};
  let httpDomains = [];
  let httpMaxBytes = 40000;
  const enginesResult = validateEngines(raw.engines);
  if (enginesResult.error) return { ok: false, error: enginesResult.error };
  if (apiVersion >= 2) {
    const settingsResult = validateSettings(raw.settings);
    if (settingsResult.error) return { ok: false, error: settingsResult.error };
    const approvalsResult = validateApprovals(raw.approvals);
    if (approvalsResult.error) return { ok: false, error: approvalsResult.error };
    if (settingsResult.settings && secretFieldKeys(settingsResult.settings).length && !capabilities.includes('secrets')) {
      return { ok: false, error: 'settings 里有 secret 字段就必须在 capabilities 里带上 "secrets"' };
    }
    if (approvalsResult.approvals.length && !capabilities.includes('approval')) {
      return { ok: false, error: '声明了 approvals 就必须在 capabilities 里带上 "approval"' };
    }
    const quotasResult = validateQuotas(raw.quotas, approvalsResult.approvals);
    if (quotasResult.error) return { ok: false, error: quotasResult.error };
    if (Object.keys(quotasResult.quotas).length && !capabilities.includes('quota')) {
      return { ok: false, error: '声明了 quotas 就必须在 capabilities 里带上 "quota"' };
    }
    const domainsResult = validateHttpDomains(raw.httpDomains);
    if (domainsResult.error) return { ok: false, error: domainsResult.error };
    if (domainsResult.httpDomains.length && !capabilities.includes('http')) {
      return { ok: false, error: '声明了 httpDomains 就必须在 capabilities 里带上 "http"' };
    }
    const declaredMax = Math.floor(Number(raw.httpMaxBytes));
    if (Number.isFinite(declaredMax) && raw.httpMaxBytes !== undefined && raw.httpMaxBytes !== null) {
      if (!capabilities.includes('http')) {
        return { ok: false, error: '声明了 httpMaxBytes 就必须在 capabilities 里带上 "http"' };
      }
      // 默认 40KB → 最高 512KB：B 站搜索这类接口 40KB 已经会截断，但也不能让插件整站拉回上下文
      httpMaxBytes = Math.max(40000, Math.min(512 * 1024, declaredMax));
    }
    settings = settingsResult.settings;
    approvals = approvalsResult.approvals;
    quotas = quotasResult.quotas;
    httpDomains = domainsResult.httpDomains;
    // 工具声明的写动作必须在 approvals 清单里：不在清单里的动作宿主无从展示与批准
    const actionNames = new Set(approvals.map((item) => item.action));
    for (const tool of tools) {
      if (tool.action && !actionNames.has(tool.action)) {
        return { ok: false, error: `工具 ${tool.name} 声明的动作 ${tool.action} 没有在 approvals 里登记` };
      }
    }
  }
  // v1 插件里的 settings/approvals/quotas/httpDomains 一律**忽略**而不是拒载：
  // 这些字段是后来加的，老插件可能早就在 manifest 里写了 settings（宿主以前不认）。
  // 升级一版就把人家已装好的插件弄成"manifest 不合法"，是最没必要的破坏性变更。
  // v1 也拿不到 v2 能力（上面的 capabilities 校验已经挡住），忽略不会扩大权限。

  return {
    ok: true,
    manifest: {
      id, apiVersion, name, version, description,
      dir: dir || '',                 // 插件目录（宿主起进程时的 cwd 与 --allow-fs-read 目标）
      entry: entryAbs || entry,
      capabilities: [...capabilities],
      tools,
      schedule,
      settings,
      approvals,
      quotas,
      httpDomains,
      httpMaxBytes,
      engines: enginesResult.engines
    }
  };
}

/**
 * 模型看到的工具名：`<插件id>__<工具名>` —— 插件之间、插件与内置工具之间都不许撞名。
 * 用双下划线而不是点号：OpenAI 的 function name 只允许 [a-zA-Z0-9_-]，点号在**严格校验**的
 * 兼容端点上会让整个请求 400 —— 那就不只是"这个工具用不了"，而是这一轮对话全挂
 *（2026-10-15 复审 P3-4）。id 里只可能有 `-`，工具名里只可能有 `_`，所以分隔符不会歧义。
 */
export function qualifiedToolName(pluginId, toolName) {
  return `${pluginId}__${toolName}`;
}
