// 群消息关键词黑名单规则（PR #80 + 2026-10-31 加固）。
//
// 设计约束：
//   1. 普通条目是大小写不敏感的**包含匹配**，成本 O(n)，默认用这个；
//   2. `re:` 前缀启用一个**有意收窄**的正则子集：
//      - 最多 1 个不限长度量词（* / + / {n,}）；
//      - 所有变长量词（含 `?`、`{n,m}`）的**组合预算**不超过 200
//        （例如 `a?` 最多 7 个、一个 `{0,199}`）；
//      - 禁止断言、反向引用、嵌套重复、超大重复；
//      - 匹配前把输入截到 2000 字符。
//      原因：JS 正则没有超时，`^a*a*a*a*b$`、`a?a?a?…`、多个 {0,1000} 都能在
//      几千字消息上爆炸回溯，而 ingest 是同步路径。只数 * 和 + 不够 —— `?` 也是
//      选择点，必须按"选择组合数"做乘积预算。
//   3. 规则在配置加载时清洗（非法条目丢弃并告警、fail-closed），保存时校验（400）；
//      编译结果按规则内容缓存，不在每条消息上重复 new RegExp。
const REGEX_PREFIX = 're:';
const MAX_RULES = 100;
const MAX_REGEX_CHARS = 160;
const MAX_UNBOUNDED_QUANTIFIERS = 1;
const MAX_BOUNDED_REPEAT = 1000;
// 变长量词的选择组合上限：200 意味着 `a?` 最多 7 个（2^7=128），
// 或一个 `{0,199}`；100 条规则 × 200 组合 × 2000 字仍在可控量级。
const MAX_VARIABLE_CHOICES = 200;
const MAX_REGEX_INPUT_CHARS = 2000;

function ruleText(rule) {
  return String(rule ?? '').trim();
}

function sourceOf(rule) {
  return ruleText(rule).slice(REGEX_PREFIX.length);
}

/**
 * 扫描正则里的量词，返回选择点数量。
 * - `*` / `+` / `{n,}` → 不限长度，计 unbounded；
 * - `?` / `{n,m}` → 选择点，choices 乘以可选值个数；
 * - `a+?` / `a{1,2}?` 的末尾 `?` 是惰性后缀，不重复计数；
 * - 字符类 `[...]` 与转义 `\x` 里的符号跳过。
 */
function analyzeQuantifiers(source) {
  let unbounded = 0;
  let choices = 1;
  let tooLarge = false;
  let inClass = false;
  let lastWasQuantifier = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { i += 1; lastWasQuantifier = false; continue; }
    if (inClass) {
      if (ch === ']') inClass = false;
      lastWasQuantifier = false;
      continue;
    }
    if (ch === '[') { inClass = true; lastWasQuantifier = false; continue; }
    if (ch === '*' || ch === '+') { unbounded += 1; lastWasQuantifier = true; continue; }
    if (ch === '?') {
      if (!lastWasQuantifier) choices *= 2;   // 否则是惰性后缀
      lastWasQuantifier = true;
      continue;
    }
    if (ch === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i));
      if (m) {
        if (m[2] === '') {
          unbounded += 1;                       // {n,}
        } else if (m[2] !== undefined) {
          const min = Number(m[1]) || 0;
          const max = Number(m[2]) || 0;
          if (min > MAX_BOUNDED_REPEAT || max > MAX_BOUNDED_REPEAT) tooLarge = true;
          if (max > min) choices *= (max - min + 1);
        } else {
          const count = Number(m[1]) || 0;      // {n} 定长，不是选择点
          if (count > MAX_BOUNDED_REPEAT) tooLarge = true;
        }
        i += m[0].length - 1;
        lastWasQuantifier = true;
        continue;
      }
    }
    lastWasQuantifier = false;
  }
  return { unbounded, choices, tooLarge };
}

function unsafeRegexReason(source) {
  if (!source) return '正则内容不能为空';
  if (source.length > MAX_REGEX_CHARS) return `正则最多 ${MAX_REGEX_CHARS} 个字符`;
  const q = analyzeQuantifiers(source);
  if (q.unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
    return `正则最多只允许 ${MAX_UNBOUNDED_QUANTIFIERS} 个不限长度的量词（*、+、{n,}）`;
  }
  if (q.tooLarge) return `有界重复的上下界不能超过 ${MAX_BOUNDED_REPEAT}`;
  if (q.choices > MAX_VARIABLE_CHOICES) {
    return `变长量词组合不能超过 ${MAX_VARIABLE_CHOICES} 种（当前约 ${q.choices} 种）`;
  }
  if (/\\[1-9]|\(\?/.test(source)) return '正则不支持反向引用或断言';
  // 分组整体重复（(a+)+ / (a|b)*）仍单独拒绝：即使只有一个不限量词，嵌套回溯也不可控
  if (/\((?:[^()\\]|\\.)*[*+?{|](?:[^()\\]|\\.)*\)\s*[*+{]/.test(source)) {
    return '正则不能重复包含量词或分支的分组';
  }
  return '';
}

/** 校验整张规则表；返回错误文案（空串 = 通过）。 */
export function validateBlacklistKeywordRules(rules) {
  if (!Array.isArray(rules)) return '';
  if (rules.length > MAX_RULES) return `黑名单关键词最多 ${MAX_RULES} 条`;
  for (const raw of rules) {
    const rule = ruleText(raw);
    if (!rule.startsWith(REGEX_PREFIX)) continue;
    const reason = unsafeRegexReason(sourceOf(rule));
    if (reason) return `黑名单规则「${rule.slice(0, 80)}」无效：${reason}`;
    try { new RegExp(sourceOf(rule), 'iu'); } catch (error) {
      return `黑名单规则「${rule.slice(0, 80)}」无效：${error.message}`;
    }
  }
  return '';
}

/**
 * 配置加载时清洗：非法/不安全的规则**丢弃**，并返回丢弃清单（供调用方告警）。
 * 返回新数组，不改原值；超过上限的部分记为 dropped。
 */
export function sanitizeBlacklistKeywordRulesWithReport(rules) {
  const dropped = [];
  if (!Array.isArray(rules)) return { rules: [], dropped };
  const out = [];
  for (const raw of rules) {
    const rule = ruleText(raw);
    if (!rule) continue;
    if (out.length >= MAX_RULES) { dropped.push({ rule: rule.slice(0, 80), reason: `超过 ${MAX_RULES} 条上限` }); continue; }
    if (rule.startsWith(REGEX_PREFIX)) {
      const reason = unsafeRegexReason(sourceOf(rule));
      if (reason) { dropped.push({ rule: rule.slice(0, 80), reason }); continue; }
      try { new RegExp(sourceOf(rule), 'iu'); } catch (error) {
        dropped.push({ rule: rule.slice(0, 80), reason: String(error?.message ?? error) });
        continue;
      }
    }
    out.push(rule);
  }
  return { rules: out, dropped };
}

/** 兼容旧调用：只要清洗后的数组。 */
export function sanitizeBlacklistKeywordRules(rules) {
  return sanitizeBlacklistKeywordRulesWithReport(rules).rules;
}

// 编译缓存：按"规则内容"缓存，配置不变时每条消息只做匹配，不再重复构造 RegExp。
let cache = { key: '', compiled: null };

function compileRules(rules) {
  // 用 JSON 编码做键：避免 \u0000 拼接在规则含 NUL 时产生碰撞
  const key = JSON.stringify(rules.map(ruleText));
  if (cache.key === key && cache.compiled) return cache.compiled;
  const literals = [];
  const regexes = [];
  for (const raw of rules) {
    const rule = ruleText(raw);
    if (!rule) continue;
    if (!rule.startsWith(REGEX_PREFIX)) {
      literals.push(rule.toLowerCase());
      continue;
    }
    const source = sourceOf(rule);
    if (unsafeRegexReason(source)) continue;
    try { regexes.push(new RegExp(source, 'iu')); } catch { /* 手改坏的正则跳过 */ }
  }
  cache = { key, compiled: { literals, regexes } };
  return cache.compiled;
}

export function matchesBlacklistKeyword(text, rules = []) {
  const input = String(text ?? '');
  if (!input || !Array.isArray(rules) || !rules.length) return false;
  const { literals, regexes } = compileRules(rules);
  if (literals.length) {
    // 用 toLowerCase 而不是 toLocaleLowerCase：与正则 `i` 和 store.keywords 的
    // 口径一致，避免 tr/az locale 下 I/İ 折叠差异导致漏杀（2026-10-31 复审 P2）。
    const lower = input.toLowerCase();
    for (const literal of literals) {
      if (literal && lower.includes(literal)) return true;
    }
  }
  if (!regexes.length) return false;
  // 正则只看前 2000 字：配合"变长量词组合预算"，把最坏回溯压到可控量级。
  const head = input.length > MAX_REGEX_INPUT_CHARS ? input.slice(0, MAX_REGEX_INPUT_CHARS) : input;
  for (const regex of regexes) {
    if (regex.test(head)) return true;
  }
  return false;
}
