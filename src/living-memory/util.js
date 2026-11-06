import crypto from 'node:crypto';

export function asText(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

export function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function clampInt(value, min, max, fallback) {
  return Math.round(clamp(value, min, max, fallback));
}

export function now() {
  return Date.now();
}

export function uuid() {
  return crypto.randomUUID();
}

export function parseJson(value, fallback) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

export function stableJson(value) {
  return JSON.stringify(value ?? null);
}

export function iso(value) {
  const time = Number(value) || now();
  return new Date(time).toISOString();
}

export function normalizeForSearch(value) {
  return asText(value, 8000).toLowerCase();
}

/** Chinese bigrams + Latin words: zero-dependency lexical fallback when vectors are unavailable. */
export function searchTerms(value) {
  const text = normalizeForSearch(value);
  const terms = new Set(text.match(/[a-z0-9_]{2,}/g) || []);
  const cjk = text.replace(/[^\u3400-\u9fff]/g, '');
  for (const character of cjk) terms.add(character);
  for (let index = 0; index < cjk.length - 1; index += 1) terms.add(cjk.slice(index, index + 2));
  return [...terms];
}

export function lexicalScore(query, candidate) {
  const normalizedQuery = normalizeForSearch(query);
  const normalizedCandidate = normalizeForSearch(candidate);
  if (!normalizedQuery || !normalizedCandidate) return 0;
  const cjkQuery = normalizedQuery.replace(/[^\u3400-\u9fff]/g, '');
  const allowCjkUnigram = cjkQuery.length <= 1;
  let score = normalizedCandidate.includes(normalizedQuery) ? 12 : 0;
  for (const term of searchTerms(normalizedQuery)) {
    if (term.length === 1 && (/^[a-z0-9]$/.test(term) || !allowCjkUnigram)) continue;
    if (normalizedCandidate.includes(term)) score += 1;
  }
  return score;
}

export function redactionReason(value) {
  const text = String(value || '');
  if (/(?:密码|口令|验证码|密钥|token|api[ _-]?key|access[ _-]?key|secret|pass(?:word)?|cvv|银行卡|卡号|身份证|护照|家庭住址|详细地址|病历|诊断|病情|政治立场|投票意向)/i.test(text)) {
    return '内容包含可能的凭据、身份、住址、医疗或政治敏感信息';
  }
  if (/(?:\b1[3-9]\d{9}\b|\b\d{15,19}\b)/.test(text)) return '内容包含可能的手机号或证件/卡号';
  return '';
}

export function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
