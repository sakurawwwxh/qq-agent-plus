// 价目类 URL 的安全抓取（2026-10-31 复审 P2）：
// 价格探测/渠道价目表/远程价格表的目标地址是用户填的 URL，必须与插件索引同一道
// SSRF 防线（内网/环回/链路本地/重定向逐跳复检）。要拉内网 one-api 的用户可显式打开
// `security.allowPrivatePriceHosts`，默认关。
import { safeFetch } from '../llm/safe-fetch.js';

export async function fetchJsonSafe(url, {
  timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, allowPrivate = false
} = {}) {
  const res = await safeFetch(String(url), {
    maxBytes,
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 10000)),
    allowPrivate
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
  if (res.truncated) {
    throw Object.assign(new Error('价目文件过大（超过 2MB）'), { code: 'BODY_TOO_LARGE' });
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error('返回的不是合法 JSON');
  }
}
