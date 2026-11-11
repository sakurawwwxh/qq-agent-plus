import { randomUUID } from 'node:crypto';
import { parse } from 'node-html-parser';
import { safeSlice } from '../core/util.js';

/** 把静态 HTML 渲染成可读正文；导出给 worker 与主线程兜底共用。 */
export function htmlText(body, url) {
  const doc = parse(body);
  // 正文空白归一化前先保护代码。用随机哨兵而不是页面文本推导：doc.text 是 getter，
  // 逐字符扩展标记会让恶意页面把这里变成 O(n²)；随机值也无法被页面预置。
  const docText = doc.text;
  let marker = `\u0000QQ_WEB_CODE_${randomUUID()}_`;
  for (let attempt = 0; attempt < 4 && docText.includes(marker); attempt += 1) {
    marker = `\u0000QQ_WEB_CODE_${randomUUID()}_`;
  }
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
    const article = articles.length === 1 ? articles[0] : null;
    text = render(article || doc.querySelector('body') || doc).trim();
    // 空的单篇文章（JS 壳/只剩被排除标签）不能遮住 body 里的静态正文。
    if (!text && article) text = render(doc.querySelector('body') || doc).trim();
  }
  text = text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  const title = safeSlice(doc.querySelector('title')?.text.trim() || '', 300);
  if (text && title && !text.includes(title)) text = `${title}\n\n${text}`;
  return text.replace(new RegExp(`${marker}(\\d+)\\u0000`, 'g'), (_, index) => code[Number(index)]);
}
