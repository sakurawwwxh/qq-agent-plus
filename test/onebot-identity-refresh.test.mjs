// 换号重连：协议端在 noVNC 里重新登录另一个 QQ 时，进程不能继续用旧 selfId。
// 旧 selfId 会让 Qzone/日报的账号绑定闸门误判成同一账号，用新登录执行旧账号的待办。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-onebot-identity-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { OneBotClient } = await import('../src/onebot/onebot.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}

async function startStack() {
  let loginUid = 111111;
  let failLogin = false;
  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/get_login_info') {
      if (failLogin) {
        res.writeHead(500).end('login unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: loginUid, nickname: `bot-${loginUid}` } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/fetch_sys_faces') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: [] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const httpPort = httpServer.address().port;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const sockets = [];
  wss.on('connection', (socket) => sockets.push(socket));
  return {
    httpPort,
    wsPort: wss.address().port,
    sockets,
    setUid(uid) { loginUid = String(uid); },
    failLogin(value) { failLogin = value; },
    async close() {
      for (const socket of sockets) { try { socket.terminate(); } catch { /* ignore */ } }
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
}

function captureWarnings() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  return { text: () => lines.join('\n'), restore() { console.warn = original; } };
}

test('重连时重新拉取 get_login_info：换号会更新 selfId 并留下日志', async (t) => {
  const stack = await startStack();
  const logs = captureWarnings();
  const bot = new OneBotClient({
    wsUrl: `ws://127.0.0.1:${stack.wsPort}`,
    httpUrl: `http://127.0.0.1:${stack.httpPort}`,
    heartbeat: 'off'
  });
  t.after(async () => { logs.restore(); bot.close(); await stack.close(); });

  await bot.connect();
  assert.ok(await waitFor(() => bot.selfId === '111111'), `首次登录号应为 111111，实际 ${bot.selfId}`);
  assert.equal(bot.selfNickname, 'bot-111111');

  stack.setUid(222222);
  bot.reconnect();
  assert.ok(await waitFor(() => bot.selfId === '222222'), `换号重连后 selfId 应为 222222，实际 ${bot.selfId}`);
  assert.equal(bot.selfNickname, 'bot-222222');
  assert.match(logs.text(), /登录账号已变化：111111 -> 222222/);
});

test('get_login_info 不可用时用事件里的 self_id 兜底，不沿用旧号', async (t) => {
  const stack = await startStack();
  stack.failLogin(true);
  const bot = new OneBotClient({
    wsUrl: `ws://127.0.0.1:${stack.wsPort}`,
    httpUrl: `http://127.0.0.1:${stack.httpPort}`,
    heartbeat: 'off'
  });
  t.after(async () => { bot.close(); await stack.close(); });

  await bot.connect();
  assert.ok(await waitFor(() => stack.sockets.length > 0), '应有 WebSocket 连接');
  stack.sockets[0].send(JSON.stringify({
    post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1, self_id: 333333
  }));
  assert.ok(await waitFor(() => bot.selfId === '333333'), `事件 self_id 应兜底成 selfId，实际 ${bot.selfId}`);
});
