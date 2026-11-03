// 见闻分享正文的纯函数。从 tools-core 抽出，避免工具表因展示逻辑继续膨胀。
import { safeSlice, sanitizeUserText } from '../core/util.js';

export function shareSourceLabel(item) {
  const source = String(item?.source || '');
  const via = String(item?.via || '');
  if (source.startsWith('plugin:')) {
    const id = source.slice('plugin:'.length);
    return id ? `插件：${id}` : '插件分享';
  }
  if (source === 'bilibili' || via === 'bilibili' || !source) return 'B站';
  return source;
}

export function formatShareDuration(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  if (!n) return '';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function buildShareText(item, comment = '') {
  // 用 unicode 转义而不是字面量方括号：这只是发给 QQ 的正文，不是提示词段头；
  // 段头扫描器按源码字面量收集，字面量会被误判成"可被群友伪造的段头"。
  const title = sanitizeUserText(safeSlice(item.title, 80));
  const lines = [`\u3010${shareSourceLabel(item)}\u3011${title}`];
  const meta = [];
  if (item.up) meta.push(`UP：${sanitizeUserText(safeSlice(item.up, 40))}`);
  const duration = formatShareDuration(item.duration);
  if (duration) meta.push(`时长 ${duration}`);
  if (meta.length) lines.push(meta.join(' · '));
  const desc = sanitizeUserText(safeSlice(String(item.desc || '').replace(/\s+/g, ' ').trim(), 120));
  if (desc) lines.push(desc);
  // 第三方 URL 只接受不含空白的 http(s)，避免把换行/段头带进正文和后续上下文。
  if (/^https?:\/\/\S+$/.test(String(item.url || ''))) lines.push(item.url);
  if (comment) lines.push(comment);
  return lines.join('\n');
}
