import { parentPort } from 'node:worker_threads';
import { htmlText } from './web-page-text.js';

// HTML 解析是同步 CPU 工作；放到 worker 里，web_fetch 不能阻塞 OneBot/其他会话。
parentPort.on('message', (message) => {
  const { id, body, url } = message || {};
  // 让主线程从“真正开始解析”起算超时，而不是把排队等待也算进去。
  parentPort.postMessage({ id, started: true });
  try {
    parentPort.postMessage({ id, text: htmlText(String(body || ''), String(url || '')) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
