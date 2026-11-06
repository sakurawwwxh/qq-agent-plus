// 管理员跨群发送的内容项解析。
//
// 媒体只接受两种来源：管理员私聊里已经收到的消息（messageId，执行时重新取一次新鲜 URL）
// 或明确的公网 http(s) URL。不接受服务器本地路径 —— 否则一条“发文件到群”的指令就能把
// 数据目录里的 config.json/密钥读出去。
import path from 'node:path';
import { assertPublicUrlLiteral } from '../llm/safe-fetch.js';
import { extractMediaFromSegments, segmentsToText } from '../onebot/onebot.js';

export const MAX_ADMIN_ITEMS = 10;
export const MAX_ADMIN_TEXT = 4000;

export class AdminMediaError extends Error {
  constructor(message, { code = 'E_ADMIN_MEDIA' } = {}) {
    super(message);
    this.name = 'AdminMediaError';
    this.code = code;
  }
}

function safeText(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

/** 聊天记录里显示成 #123；模型很可能原样传回来。 */
export function normalizeMessageId(value) {
  const raw = String(value ?? '').trim().replace(/^#+/, '');
  return /^-?[1-9]\d*$/.test(raw) ? raw : '';
}

function segmentsOf(info) {
  const raw = info?.message ?? info?.data?.message ?? info?.data ?? [];
  return Array.isArray(raw) ? raw : [];
}

async function freshSegments({ onebot, messageId }) {
  if (typeof onebot?.getMsg !== 'function') return [];
  try {
    return segmentsOf(await onebot.getMsg(Number(messageId)));
  } catch {
    return [];
  }
}

function imageFromMedia(media = []) {
  return (Array.isArray(media) ? media : []).find((item) => item?.kind === 'image' && item.url) || null;
}

function audioFromMedia(media = []) {
  return (Array.isArray(media) ? media : []).find((item) => item?.kind === 'audio' && item.url) || null;
}

function fileFromSegments(segments = []) {
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (seg?.type !== 'file') continue;
    const data = seg.data || {};
    const url = String(data.url || '').trim();
    const name = String(data.name || data.file || '').trim();
    if (url) return { url, name };
  }
  return null;
}

function cleanName(value, fallback = 'file') {
  const base = path.basename(String(value || '').trim()).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
  return (base || fallback).slice(0, 120);
}

async function resolveMediaUrl({ item, onebot, store, ownerChatKey, kind }) {
  const messageId = normalizeMessageId(item?.messageId);
  // messageId 优先：工具描述承诺“已有消息优先于 url”，而且它执行时会重新取新鲜 URL。
  if (messageId) {
    const entry = store?.findByMid?.(ownerChatKey, messageId);
    if (!entry) throw new AdminMediaError(`当前私聊里找不到消息 #${messageId}`);
    const segments = await freshSegments({ onebot, messageId });
    if (kind === 'image') {
      const fresh = imageFromMedia(extractMediaFromSegments(segments));
      if (fresh?.url) return fresh.url;
      const cached = imageFromMedia(entry.media);
      if (cached?.url) return cached.url;
      throw new AdminMediaError(`消息 #${messageId} 里没有图片`);
    }
    if (kind === 'file') {
      const file = fileFromSegments(segments);
      if (file?.url) return file;
      throw new AdminMediaError(`消息 #${messageId} 里没有可转发的文件`);
    }
    const fresh = audioFromMedia(extractMediaFromSegments(segments));
    if (fresh?.url) return fresh.url;
    const cached = audioFromMedia(entry.media);
    if (cached?.url) return cached.url;
    throw new AdminMediaError(`消息 #${messageId} 里没有语音`);
  }
  if (item?.url) return String(assertPublicUrlLiteral(item.url, { label: kind === 'image' ? '图片地址' : '文件地址' }));
  throw new AdminMediaError(`${kind} 需要 messageId 或公网 URL`);
}

async function buildForwardNode({ item, onebot, store, ownerChatKey }) {
  const messageId = normalizeMessageId(item?.messageId);
  if (!messageId) throw new AdminMediaError('聊天记录卡片需要 messageId');
  const entry = store?.findByMid?.(ownerChatKey, messageId);
  if (!entry) throw new AdminMediaError(`当前私聊里找不到消息 #${messageId}`);
  const segments = await freshSegments({ onebot, messageId });
  const text = segments.length ? await segmentsToText(segments, {}) : String(entry.text || '');
  const images = extractMediaFromSegments(segments)
    .filter((media) => media.kind === 'image' && media.url)
    .slice(0, 6);
  const content = [];
  if (text.trim()) content.push({ type: 'text', data: { text: text.slice(0, 3000) } });
  for (const image of images) content.push({ type: 'image', data: { file: image.url } });
  if (!content.length) throw new AdminMediaError(`消息 #${messageId} 没有可转发的内容`);
  return [{
    type: 'node',
    data: {
      nickname: String(entry.senderName || '管理员').slice(0, 40),
      content
    }
  }];
}

/**
 * 计划阶段只校验并保存“来源”，不把媒体 URL 固化进动作文件：
 * 确认窗口内签名 URL 可能过期，执行时必须重新解析。
 * @returns {Promise<{items: Array, chars: number}>}
 */
export async function normalizeItems({
  items, onebot, store, ownerChatKey
} = {}) {
  const raw = Array.isArray(items) ? items : (items == null ? [] : [items]);
  if (!raw.length) throw new AdminMediaError('发送内容为空');
  if (raw.length > MAX_ADMIN_ITEMS) throw new AdminMediaError(`一次最多 ${MAX_ADMIN_ITEMS} 个内容项`);
  const out = [];
  let chars = 0;
  for (const value of raw) {
    const item = typeof value === 'string' ? { type: 'text', text: value } : (value || {});
    const type = String(item.type || 'text').trim();
    if (type === 'text') {
      const text = safeText(item.text ?? item.content, MAX_ADMIN_TEXT);
      if (!text) throw new AdminMediaError('文字内容为空');
      chars += text.length;
      out.push({ type: 'text', text });
    } else if (type === 'image') {
      const messageId = normalizeMessageId(item.messageId);
      if (messageId) {
        await resolveMediaUrl({ item: { messageId }, onebot, store, ownerChatKey, kind: 'image' });
        out.push({ type: 'image', messageId, desc: safeText(item.desc || item.text, 80) });
      } else {
        const url = await resolveMediaUrl({ item, onebot, store, ownerChatKey, kind: 'image' });
        out.push({ type: 'image', url, desc: safeText(item.desc || item.text, 80) });
      }
    } else if (type === 'file') {
      const messageId = normalizeMessageId(item.messageId);
      if (messageId) {
        const resolved = await resolveMediaUrl({ item: { messageId }, onebot, store, ownerChatKey, kind: 'file' });
        out.push({ type: 'file', messageId, name: cleanName(item.name || resolved.name) });
      } else {
        const url = await resolveMediaUrl({ item, onebot, store, ownerChatKey, kind: 'file' });
        out.push({ type: 'file', url, name: cleanName(item.name) });
      }
    } else if (type === 'voice') {
      const messageId = normalizeMessageId(item.messageId);
      if (messageId) await resolveMediaUrl({ item: { messageId }, onebot, store, ownerChatKey, kind: 'voice' });
      const url = messageId ? '' : await resolveMediaUrl({ item, onebot, store, ownerChatKey, kind: 'voice' });
      out.push({
        type: 'voice', ...(messageId ? { messageId } : { url }),
        seconds: Math.max(0, Math.min(600, Number(item.seconds) || 0)),
        label: safeText(item.label || item.text, 60)
      });
    } else if (type === 'aiVoice') {
      const text = safeText(item.text, 60);
      if (!text) throw new AdminMediaError('AI 语音内容为空');
      out.push({ type: 'aiVoice', text, character: safeText(item.character, 80) });
    } else if (type === 'forward') {
      const messageId = normalizeMessageId(item.messageId);
      await buildForwardNode({ item: { messageId }, onebot, store, ownerChatKey });
      out.push({ type: 'forward', messageId });
    } else {
      throw new AdminMediaError(`不支持的内容类型：${type}`);
    }
  }
  if (chars > MAX_ADMIN_TEXT) throw new AdminMediaError(`文字总量超过 ${MAX_ADMIN_TEXT} 字`);
  if (!out.length) throw new AdminMediaError('发送内容为空');
  return { items: out, chars };
}

/** 执行阶段按 messageId 重新解析媒体；显式 URL 原样返回。 */
export async function refreshItem(item, { onebot, store, ownerChatKey } = {}) {
  if (!item?.messageId) return item;
  const messageId = normalizeMessageId(item.messageId);
  if (!messageId) throw new AdminMediaError('消息 id 不合法');
  if (item.type === 'image') {
    return { ...item, url: await resolveMediaUrl({ item: { messageId }, onebot, store, ownerChatKey, kind: 'image' }) };
  }
  if (item.type === 'file') {
    const resolved = await resolveMediaUrl({ item: { messageId }, onebot, store, ownerChatKey, kind: 'file' });
    return { ...item, url: resolved.url, name: cleanName(item.name || resolved.name) };
  }
  if (item.type === 'voice') {
    return { ...item, url: await resolveMediaUrl({ item: { messageId }, onebot, store, ownerChatKey, kind: 'voice' }) };
  }
  if (item.type === 'forward') {
    return { ...item, nodes: await buildForwardNode({ item: { messageId }, onebot, store, ownerChatKey }) };
  }
  return item;
}

export function describeItems(items = []) {
  const names = [];
  for (const item of items) {
    if (item.type === 'text') {
      const text = String(item.text || '');
      names.push(`文字「${text.slice(0, 120)}${text.length > 120 ? '…' : ''}」（${text.length} 字）`);
    }
    else if (item.type === 'image') names.push('图片');
    else if (item.type === 'forward') names.push('聊天记录卡片');
    else if (item.type === 'file') names.push(`文件 ${item.name}`);
    else if (item.type === 'voice') names.push(`语音${item.seconds ? ` ${item.seconds} 秒` : ''}`);
    else if (item.type === 'aiVoice') names.push(`AI 语音「${String(item.text).slice(0, 20)}」`);
    else names.push(item.type);
  }
  return names.join('；');
}
