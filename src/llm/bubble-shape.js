// 拟人气泡整形：模型最好主动传数组，但不能指望它每次都这样。
// 这里把一段长回复按标点拆成 1–3 条气泡，保护代码块、URL、行内代码和常见颜文字；
// 已经分好的数组只做长度合并，不改变原有顺序。
const PLACEHOLDER = /\u0000(\d+)\u0000/g;
const HAS_PLACEHOLDER = /\u0000\d+\u0000/;

function protect(text) {
  const parts = [];
  const stash = (value) => `\u0000${parts.push(value) - 1}\u0000`;
  let out = String(text ?? '');
  out = out.replace(/```[\s\S]*?```/g, (match) => stash(match));
  out = out.replace(/`[^`\n]+`/g, (match) => stash(match));
  out = out.replace(/https?:\/\/[^\s，。！？；、"')】]+/gi, (match) => stash(match));
  // 常见颜文字：括号内部不拆开（只保护短片段，避免把正常括号内容也吞掉）。
  out = out.replace(/[（(][^（）()\n\u0000]{1,16}[）)]/g, (match) => stash(match));
  return { text: out, parts };
}

function restore(text, parts) {
  return String(text ?? '').replace(PLACEHOLDER, (_match, index) => parts[Number(index)] ?? '');
}

function joinChunks(left, right, separator = '') {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a) return b;
  if (!b) return a;
  // 中文/标点结尾直接拼；英文单词之间补一个空格。
  const glue = separator || (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? ' ' : '');
  return `${a}${glue}${b}`;
}

/** 把一条消息拆成待打包的片段。含代码/链接/颜文字的段落整段保留。 */
function chunksOf(message, charLimit) {
  const { text: guarded, parts } = protect(message);
  const out = [];
  const paragraphs = guarded.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    // 占位符说明这段里有代码块、行内代码、URL 或短括号：整段发，不再按句子切。
    if (HAS_PLACEHOLDER.test(paragraph)) {
      out.push({ text: restore(paragraph, parts), keepAlone: true });
      continue;
    }
    const sentences = paragraph.split(/(?<=[。！？!?；;…])\s*/).map((piece) => piece.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length <= charLimit) {
        out.push({ text: sentence, keepAlone: false });
      } else {
        for (let at = 0; at < sentence.length; at += charLimit) {
          out.push({ text: sentence.slice(at, at + charLimit).trim(), keepAlone: false });
        }
      }
    }
  }
  return out;
}

/**
 * @param {string|string[]} messages 模型给的文本或数组
 * @param {{maxBubbles?: number, maxChars?: number, preserveCode?: boolean}} options
 * @returns {string[]} 1–maxBubbles 条气泡
 */
export function shapeBubbles(messages, { maxBubbles = 3, maxChars = 60 } = {}) {
  const list = (Array.isArray(messages) ? messages : [messages])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
  if (!list.length) return [];
  const bubbleLimit = Math.max(1, Math.min(8, Math.round(Number(maxBubbles) || 3)));
  const charLimit = Math.max(10, Math.min(2000, Math.round(Number(maxChars) || 60)));
  // 模型已经主动分好条、且每条都不超长时，尊重它的分条，不再按短句重新打包。
  if (list.length > 1 && list.every((item) => item.length <= charLimit)) {
    if (list.length <= bubbleLimit) return list.slice(0, bubbleLimit);
    return [...list.slice(0, bubbleLimit - 1), joinChunks(list[bubbleLimit - 1], list.slice(bubbleLimit).join(''))];
  }

  const chunks = [];
  for (const message of list) chunks.push(...chunksOf(message, charLimit));
  if (!chunks.length) return list.slice(0, bubbleLimit);

  const bubbles = [];
  for (const chunk of chunks) {
    const last = bubbles[bubbles.length - 1];
    const mergeable = last && !last.keepAlone && !chunk.keepAlone
      && joinChunks(last.text, chunk.text).length <= charLimit;
    if (mergeable) {
      bubbles[bubbles.length - 1] = { text: joinChunks(last.text, chunk.text), keepAlone: false };
    } else if (bubbles.length < bubbleLimit) {
      bubbles.push({ ...chunk });
    } else {
      // 上限优先：把剩余内容并进最后一条，宁可长一点，也不刷屏。
      // 代码块与正文之间用换行隔开，避免粘成一行看不出边界。
      const previous = bubbles[bubbles.length - 1];
      bubbles[bubbles.length - 1] = {
        text: joinChunks(previous.text, chunk.text, previous.keepAlone || chunk.keepAlone ? '\n' : ''),
        keepAlone: previous.keepAlone || chunk.keepAlone
      };
    }
  }
  return bubbles.map((bubble) => bubble.text.trim()).filter(Boolean).slice(0, bubbleLimit);
}
