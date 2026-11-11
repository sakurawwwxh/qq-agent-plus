import { Worker } from 'node:worker_threads';
import { safeSlice } from '../core/util.js';
import { htmlText } from './web-page-text.js';
import { safeFetchRequest } from './safe-fetch.js';

const MAX_FETCH_BYTES = 512 * 1024;
const MAX_CONTENT_CHARS = 20000;
const PARSE_TIMEOUT_MS = 5000;

let parserWorker = null;
let parserIdleTimer = null;
let parseSeq = 0;
const parsePending = new Map();

function scheduleParserIdleStop() {
  if (parserIdleTimer) clearTimeout(parserIdleTimer);
  parserIdleTimer = setTimeout(() => {
    parserIdleTimer = null;
    if (!parsePending.size) stopParserWorker(new Error('HTML 解析 worker 空闲退出'));
  }, 1000);
  parserIdleTimer.unref?.();
}

function stopParserWorker(error) {
  if (parserIdleTimer) {
    clearTimeout(parserIdleTimer);
    parserIdleTimer = null;
  }
  const worker = parserWorker;
  parserWorker = null;
  for (const [id, entry] of parsePending) {
    if (entry.worker !== worker) continue;
    parsePending.delete(id);
    entry.cleanup();
    entry.reject(error instanceof Error ? error : new Error(String(error || 'HTML 解析失败')));
  }
  if (worker) worker.terminate().catch(() => {});
}

function getParserWorker() {
  if (parserIdleTimer) {
    clearTimeout(parserIdleTimer);
    parserIdleTimer = null;
  }
  if (parserWorker) return parserWorker;
  // 不继承父进程的 --test / --experimental-test-coverage 等 execArgv：
  // worker 只需要普通模块解析，继承测试参数会直接启动失败或挂住。
  const worker = new Worker(new URL('./web-page-worker.js', import.meta.url), { execArgv: [] });
  worker.unref?.();
  worker.on('message', (message) => {
    const entry = parsePending.get(message?.id);
    if (!entry || entry.worker !== worker) return;
    parsePending.delete(message.id);
    entry.cleanup();
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(String(message.text || ''));
    scheduleParserIdleStop();
  });
  worker.on('error', (error) => stopParserWorker(error));
  worker.on('exit', (code) => {
    if (parserWorker === worker) stopParserWorker(new Error(`HTML 解析 worker 退出（code=${code}）`));
  });
  parserWorker = worker;
  return worker;
}

/** 在 worker 里解析；超时就终止 worker，避免病态页面永久占住队列。 */
function parseHtmlInWorker(body, url, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('已取消'));
  let worker;
  try {
    worker = getParserWorker();
  } catch {
    // worker 创建失败是环境问题，退回主线程解析（只在这种情况下阻塞）。
    try { return Promise.resolve(htmlText(body, url)); }
    catch (error) { return Promise.reject(error); }
  }
  return new Promise((resolve, reject) => {
    const id = ++parseSeq;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (!parsePending.has(id)) return;
      parsePending.delete(id);
      cleanup();
      reject(error);
      scheduleParserIdleStop();
    };
    const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('已取消'));
    const timer = setTimeout(() => {
      fail(new Error(`HTML 解析超时（>${PARSE_TIMEOUT_MS}ms）`));
      stopParserWorker(new Error(`HTML 解析超时（>${PARSE_TIMEOUT_MS}ms）`));
    }, PARSE_TIMEOUT_MS);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    parsePending.set(id, {
      worker,
      cleanup,
      resolve: (text) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(text); },
      reject: (error) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); }
    });
    try {
      worker.postMessage({ id, body, url });
    } catch (error) {
      fail(error);
    }
  });
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
      content = await parseHtmlInWorker(body, result.url, { signal: combined });
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
