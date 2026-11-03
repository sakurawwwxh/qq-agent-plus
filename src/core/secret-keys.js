// 密钥字段的统一判定与脱敏（改进方案 #5/#6 共同前置）。
// SECRET_KEY_PATTERN / SECRET_KEY_EXCLUDE / sanitizeConfigSecrets 从 src/console/app.js 逐字迁出，
// 控制台配置脱敏与审计脱敏从此共用同一份模式表，避免两处口径漂移。
import { redactSecretValue } from './redact.js';
//
// 判定口径：字段名命中 SECRET_KEY_PATTERN 即视为"值本身是密钥"；`*From` 结尾的字段存的是
// 来源标识（如 manual），`has*` 布尔是派生标记，都不算。
//
// 2026-09-30 审查 P1 补了几类在配置里真实会出现的**请求头 / 凭据容器**名：
//   authorization / auth / x-api-key / x_api_key / cookie / bearer
// 它们常在 api.extraBody、api.thinkingParams 这类"高级逃生口"里被用户原样填成请求头，
// 原来不含这些词的模式会漏过、把明文密钥写进审计文件（审计会把整份配置落盘）。
// 仍**故意不含**裸 `key`：普通业务字段大量叫 xxxKey（sortKey、sortkey、clientKey…），
// 加了会把无关字段整片抹成 [redacted]（`*From` 的排除也拦不住这些）。
export const SECRET_KEY_PATTERN = /(^token$|apikey|api_key|accesstoken|access_token|secret|password|privatekey|private_key|authorization|^auth$|x-api-key|x_api_key|^cookie$|^bearer$)/i;
// 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
export const SECRET_KEY_EXCLUDE = /from$/i;

/** 对象/数组里有没有"非空的叶子"：用来判断 `{value:'Bearer sk-…'}` 这种形态算不算"有密钥"。 */
function containsSomething(value, depth = 0) {
  if (depth > 4) return Boolean(value);
  if (value == null) return false;
  if (typeof value !== 'object') return Boolean(String(value).trim());
  return Object.values(value).some((v) => containsSomething(v, depth + 1));
}

// ── 配置形态脱敏（控制台 /api/config 下发用，语义与迁出前逐字一致）────────────────
/**
 * 凡是字段名命中 SECRET_KEY_PATTERN 的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
 * 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password …
 */
export function sanitizeConfigSecrets(cfg) {
  const out = JSON.parse(JSON.stringify(cfg ?? {}));
  const seen = new WeakSet();

  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      // ⚠️ 顺序要紧：先判"这个键名是不是密钥"，再决定要不要往里递归。
      // 反过来（先递归、对象就 continue）的话，**对象/数组形态**的密钥字段会整条漏过去 ——
      // `api.extraBody.authorization = {value:'Bearer sk-…'}` 里的明文原样下发到浏览器
      //（2026-10-04 复审 P3 实测：`apiKey:{value:'sk-NESTED'}`、`token:['sk-ARR']` 均明文）。
      // 键名命中密钥模式时，无论值是字符串还是对象/数组，一律整条删除 + 生成 hasXxx。
      if (SECRET_KEY_EXCLUDE.test(key)) continue;
      // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
      // 不排除就会连锁生成 hasHasXxx
      if (/^has/i.test(key) && typeof value === 'boolean') continue;
      if (SECRET_KEY_PATTERN.test(key)) {
        // ⚠️ 必须"删除字段"而不是"置为空串"。
        // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
        // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
        // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
        // 删掉字段则展开时不会带上该键，服务端原值得以保留。
        // 对象值要先探一下里面有没有真东西：有就仍算"有密钥"（hasXxx 才有意义）。
        const hasValue = value && typeof value === 'object'
          ? containsSomething(value)
          : Boolean(String(value ?? '').trim());
        delete node[key];
        const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        node[flagName] = hasValue;
        continue;
      }
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(out);

  // 密钥集合整体清空（不逐 key 暴露存在性）
  if (out.providerKeys && typeof out.providerKeys === 'object') {
    const has = {};
    for (const [k, v] of Object.entries(out.providerKeys)) has[k] = Boolean(String(v ?? '').trim());
    out.providerKeys = {};
    out.providerKeyPresence = has;
  }

  // keys 映射同款处理（2026-09-29 审查 P1；2026-10-02 扩到 imageGen / asr）：SECRET_KEY_PATTERN
  // 只匹配字段名，"按服务 id / 主机存 Key" 的 keys 映射（{ siliconflow: 'sk-…' }）会整包穿过去、
  // 明文下发。前端的"哪几家存过"口径由各自的派生结论另行下发：ttsKeyServices（tts）、
  // keyHosts（imageGen）、keySlots（asr）。
  for (const section of ['tts', 'imageGen', 'asr']) {
    const node = out[section];
    // 类型无关：手改坏的 keys（字符串/数组/数字）同样不能明文下发 —— 名称不含 apikey/secret，
    // 走到这里之前谁也拦不住它（2026-10-02 全量审查实测：`"keys":"sk-xxx"` 会原样发给浏览器）。
    if (node && typeof node === 'object' && 'keys' in node) {
      node.keys = {};
    }
  }

  // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
  if (Array.isArray(out.providers)) {
    for (const p of out.providers) {
      const real = (cfg?.providerKeys || {})[p.id] || p.apiKey;
      delete p.apiKey;
      p.hasKey = Boolean(String(real ?? '').trim());
    }
  }
  // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
  if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

  // MCP env/args：第三方 server 的密钥常写在 env 或 --token=… 里。walk 会把 env 里的
  // API_KEY 整条删掉（前端再保存时就永久丢了），所以这里用原始值重建一份带掩码的副本：
  // 非空密钥显示 ******，保存时服务端按 server id + key 恢复；非密钥 env 原样保留。
  if (out.mcp && Array.isArray(out.mcp.servers) && Array.isArray(cfg?.mcp?.servers)) {
    const byId = new Map(cfg.mcp.servers.map((server) => [String(server?.id || ''), server]));
    out.mcp.servers = out.mcp.servers.map((server) => {
      const original = byId.get(String(server?.id || '')) || {};
      const env = {};
      for (const [key, value] of Object.entries(original.env || {})) {
        // env 的键名不可靠（GITHUB_TOKEN / DATABASE_URL / SENTRY_AUTH_TOKEN 都可能不含
        // 模式里那几个词），与 doctor 同口径：值一律掩码，键名保留。前端保存时按
        // id+key 的 '******' 回填原值（routes/config.js 已处理）。
        env[key] = String(value ?? '').trim() ? '******' : value;
      }
      // args 除了 --token=xxx 的内联形态，还要掩“敏感 flag 的下一个参数”：
      // ["--api-key", "sk-live"] 这种分参数写法原先会原样下发。
      const flag = /^--?(?:.*[-_])?(?:key|token|secret|pass(word|wd)?|auth|authorization|header|cookie)/i;
      const args = [];
      const list = Array.isArray(original.args) ? original.args : [];
      for (let i = 0; i < list.length; i += 1) {
        const arg = String(list[i] ?? '');
        args.push(/(token|key|secret|password)=/i.test(arg) ? '******' : arg);
        if (!arg.includes('=') && flag.test(arg) && i + 1 < list.length) {
          args.push('******');
          i += 1;
        }
      }
      return { ...server, env, args };
    });
  }

  return out;
}

// ── 审计用通用脱敏 ─────────────────────────────────────────────────────────
// 凭据集合字段：模式表不匹配裸 key（故意的，避免误伤普通 "key" 字段），但
// { keys: { 服务名: 'sk-…' } } 这类映射的内部键名不含模式，逐层递归就会漏 ——
// 命中这些名字时整包隐藏（2026-09-30 写单测时抓到的真缺口）。
const SECRET_CONTAINER = /^(keys|providerkeys|ttskeys)$/i;

/**
 * 任意 JSON 值 → 一份副本，命中密钥字段名的值整体替换为 '[redacted]'。
 * 与 sanitizeConfigSecrets 同一份模式表，但语义不同：这里不"删字段 + 补 hasXxx"，
 * 而是留下 '[redacted]' 标记 —— 审计日志要能看出"这里原本有个值"。
 * - `*From`（来源标识）与 `has*` 布尔（派生标记）不脱敏；
 * - 密钥字段名（或 SECRET_CONTAINER）的值是对象/数组时**整包替换**，否则内部键名不含模式会漏网；
 * - **字符串值再过一遍按值脱敏**（redactSecretValue）：字段名不含关键词、值却是
 *   `sk-…` / `Bearer …` / `?access_token=…` 的，靠这一步兜住
 *   （2026-09-30 审查 P1：审计会把整份配置落盘，只按字段名判会漏）；
 * - 循环引用 → '[circular]'，超 12 层 → '[depth-limit]'（审计是旁路，宁缺勿炸）。
 */
export function redactSecretFields(value) {
  const seen = new WeakSet();
  const walk = (node, depth) => {
    if (typeof node === 'string') return redactSecretValue(node);
    if (node === null || typeof node !== 'object') return node;
    if (depth > 12) return '[depth-limit]';
    if (seen.has(node)) return '[circular]';
    seen.add(node);
    if (Array.isArray(node)) return node.map((v) => walk(v, depth + 1));
    const out = {};
    for (const [key, v] of Object.entries(node)) {
      if (/^has/i.test(key) && typeof v === 'boolean') { out[key] = v; continue; }
      if (SECRET_CONTAINER.test(key)) { out[key] = '[redacted]'; continue; }
      if (SECRET_KEY_EXCLUDE.test(key)) { out[key] = walk(v, depth + 1); continue; }
      if (SECRET_KEY_PATTERN.test(key)) { out[key] = '[redacted]'; continue; }
      out[key] = walk(v, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}
