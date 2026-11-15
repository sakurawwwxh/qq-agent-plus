import { normalizeReplacementTriggers } from '../core/model-replacement-config.js';

// Exact machine-readable identifiers only. Generic quota_exceeded can mean a
// short-window limit and is deliberately not treated as depleted credit.
const DEPLETED_QUOTA_CODES = new Set([
  'insufficient_quota', 'insufficient_balance', 'insufficient_credits', 'billing_hard_limit_reached'
]);
export function modelHttpError(message, status, body = null) {
  let parsed = body;
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { parsed = null; }
  }
  const detail = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const token = (v) => typeof v === 'string' ? v.trim().toLowerCase().slice(0, 128) : '';
  // Keep identifiers, never retain response bodies / credentials on the error.
  return Object.assign(new Error(message), {
    status: Number(status), modelRequest: true,
    modelErrorCode: token(detail?.code), modelErrorType: token(detail?.type)
  });
}
export function isModelReplacementError(error, rawTriggers) {
  if (error?.modelRequest !== true) return false;
  const triggers = normalizeReplacementTriggers(rawTriggers);
  if (error.status === 401) return triggers.http401;
  if (error.status === 402) return triggers.http402;
  if (error.status === 403) return triggers.http403;
  return error.status === 429 && triggers.quota429
    && (DEPLETED_QUOTA_CODES.has(error.modelErrorCode) || DEPLETED_QUOTA_CODES.has(error.modelErrorType));
}
