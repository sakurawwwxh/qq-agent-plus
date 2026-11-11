// 把 agent 的 Markdown 回复转成适合 QQ 发送的纯文本。（移植自 qq-bridge src/llm/md-to-plain.js）
import { randomUUID } from 'node:crypto';

export function mdToPlain(md, { preserveCode = false } = {}) {
  let s = String(md ?? '');
  const protectedText = [];
  const marker = `\u0000QQTEXT${randomUUID()}Z`;
  const protect = (body) => `${marker}${protectedText.push(body) - 1}\u0000`;
  // Protect code before prose replacements can consume operators such as *, > and |.
  if (preserveCode) {
    s = s.replace(
      /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*(?=\r?$)/gm,
      (_, fence, body) => protect(body.replace(/\r?\n$/, ''))
    );
    s = s.replace(/(`+)([^`\r\n]+)\1/g, (_, ticks, body) => protect(body));
  }
  // 代码块：保留内容，去掉围栏
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''));
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片/链接：保留文字，链接附在括号里（QQ 可点）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => (alt || url));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // URL 内的格式字符属于地址；只把正文中已打开的结尾标记留给后续清理。
  const emphasis = new Set();
  const trackEmphasis = (text) => {
    for (const [mark] of text.matchAll(/\*{1,3}|__|~~/g)) {
      if (emphasis.has(mark)) emphasis.delete(mark);
      else emphasis.add(mark);
    }
  };
  let scanned = 0;
  s = s.replace(/https?:\/\/[^\s，。！？；、（）【】<>"`\u0000]+/gi, (url, offset, source) => {
    trackEmphasis(source.slice(scanned, offset));
    scanned = offset + url.length;
    let end = url.length;
    let depth = 0;
    for (let i = 0; source[offset - 1] === '(' && i < end; i++) {
      if (url[i] === '(') depth++;
      else if (url[i] === ')') {
        if (depth === 0) { end = i; break; }
        depth--;
      }
    }
    let boundary = end;
    while (boundary > 0 && /[.,!?;:]/.test(url[boundary - 1])) boundary--;
    const bareEnd = boundary;
    const open = new Set(emphasis);
    // 最多五种外层标记；不反复扩展哨兵或重新扫描整段消息。
    for (let i = 0; i < 5; i++) {
      const mark = ['***', '**', '*', '__', '~~'].find((value) => open.has(value)
        && url.slice(0, boundary).endsWith(value));
      if (!mark) break;
      open.delete(mark);
      boundary -= mark.length;
    }
    if (boundary < bareEnd) end = boundary;
    const tail = url.slice(end);
    trackEmphasis(tail);
    return protect(url.slice(0, end)) + tail;
  });
  // 粗体/斜体/删除线标记
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 标题符
  s = s.replace(/^#{1,6}\s+/gm, '');
  // 引用符
  s = s.replace(/^>\s?/gm, '');
  // 列表符
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  // 表格：按行保留文本
  s = s.split('\n').filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.includes('|') === false || /\S/.test(line.replace(/[\s:|-]/g, ''))).join('\n');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  // 折叠的连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  s = s.replace(new RegExp(`${marker}(\\d+)\\u0000`, 'g'), (_, index) => protectedText[Number(index)]);
  return s;
}

/** 按 QQ 单条消息长度上限切分（群消息一般 ≤ 4500 字，留余量）。 */
export function splitForQQ(text, max = 4000) {
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 4000;
  const parts = [];
  let rest = text;
  while (rest.length > safeMax) {
    let cut = rest.lastIndexOf('\n', safeMax);
    let eat = 0;
    if (cut <= 0) {
      cut = safeMax;
    } else {
      eat = 1; // 换行符保留给前一段，避免拼接后丢换行
    }
    // 若切点正好落在代理对中间（emoji 等会被切成乱码），把切点前移一个码元
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    if (cut <= 0) {
      const first = rest.charCodeAt(0);
      const second = rest.charCodeAt(1);
      cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
      eat = 0;
    }
    parts.push(rest.slice(0, cut + eat));
    rest = rest.slice(cut + eat);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
