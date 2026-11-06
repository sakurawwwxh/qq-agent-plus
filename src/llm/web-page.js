import { parse } from 'node-html-parser';
import { safeSlice } from '../core/util.js';
import { safeFetchRequest } from './safe-fetch.js';

const MAX_FETCH_BYTES = 512 * 1024;
const MAX_CONTENT_CHARS = 20000;

function htmlText(body, url) {
  const doc = parse(body);
  // 正文空白归一化前先保护代码；标记避开页面已有的解码文本。
  let marker = '\u0000QQ_WEB_CODE_';
  while (doc.text.includes(marker)) marker += '_';
  const code = [];
  // 不逐个替换 DOM 节点：大量同级链接下的数组查找/搬移会放大到平方级。
  function render(node) {
    if (node.nodeType === 3) return node.text;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName || '';
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|NAV)$/.test(tag)
      || node.getAttribute('role') === 'navigation') return '';
    if (tag === 'PRE') {
      const raw = (part) => part.nodeType === 3 ? part.text
        : part.tagName === 'BR' ? '\n' : part.childNodes.map(raw).join('');
      return `\n${marker}${code.push(raw(parse(node.innerHTML))) - 1}\u0000\n`;
    }
    if (tag === 'BR') return '\n';
    if (tag === 'TR') {
      const cells = node.childNodes.filter((child) => ['TH', 'TD'].includes(child.tagName));
      return `\n${cells.map((cell) => render(cell).trim()).join(' | ')}\n`;
    }
    const text = node.childNodes.map(render).join('');
    if (tag === 'A') {
      const href = String(node.getAttribute('href') || '').trim();
      if (href && !href.startsWith('#')) {
        try {
          const target = new URL(href, url);
          if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) {
            return text.trim() && text.trim() !== target.href ? `${text} (${target.href})` : target.href;
          }
        } catch { /* 无效链接保留原标签，不发起额外请求 */ }
      }
    }
    return /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|DT|DD|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|OL|P|SECTION|TABLE|TBODY|THEAD|UL)$/.test(tag)
      ? `\n${text}\n` : text;
  }
  let text = '';
  for (const main of doc.querySelectorAll('main,[role="main"]')) {
    text = render(main).trim();
    if (text) break;
  }
  if (!text) {
    const articles = doc.querySelectorAll('article');
    text = render(articles.length === 1 ? articles[0] : doc.querySelector('body') || doc).trim();
  }
  text = text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  const title = safeSlice(doc.querySelector('title')?.text.trim() || '', 300);
  if (text && title && !text.includes(title)) text = `${title}\n\n${text}`;
  return text.replace(new RegExp(`${marker}(\\d+)\\u0000`, 'g'), (_, index) => code[Number(index)]);
}

/** web_fetch 专用的静态正文出口；共享抓取层仍向其他调用者返回原始响应。 */
export async function fetchWebPage(url, { signal } = {}) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(20000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const result = await safeFetchRequest(url, { maxBytes: MAX_FETCH_BYTES, signal: combined });
  combined.throwIfAborted();
  const body = String(result.body || '');
  const type = String(result.contentType || '').split(';')[0].trim().toLowerCase();
  const isHtml = ['text/html', 'application/xhtml+xml'].includes(type)
    || (!type && /^\s*(?:<!doctype\s+html\b|<html[\s>]|<head[\s>]|<body[\s>])/i.test(body));
  let content = body;
  let note = '';
  if (isHtml) {
    try {
      content = htmlText(body, result.url);
      note = content
        ? '以下为静态页面文本，未执行 JavaScript；登录或验证页可能不包含目标正文。'
        : '未取得可读的静态正文，页面可能需要 JavaScript、登录或验证。';
    } catch {
      content = '';
      note = 'HTML 解析失败，未取得可读正文。';
    }
  }
  if (result.statusCode >= 400) note = `HTTP ${result.statusCode}，以下是错误页内容，不代表目标正文。${note}`;
  return {
    url: result.url,
    statusCode: result.statusCode,
    truncated: result.truncated || content.length > MAX_CONTENT_CHARS,
    content: safeSlice(content, MAX_CONTENT_CHARS),
    ...(note ? { note } : {})
  };
}
