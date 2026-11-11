// 浏览器冒烟契约：测试进程与 scripts/e2e-server.mjs 共用。
// 端口不能写死 33210：本机并发跑两个 Playwright、或残留服务没退干净时，
// webServer 会直接 EADDRINUSE，整个浏览器 job 红掉。配置加载时同步挑一个
// 空闲端口写进 E2E_PORT，worker 与 e2e-server 都从环境变量继承。
import { execFileSync } from 'node:child_process';

function pickFreePort() {
  const script = [
    "const net=require('node:net');",
    "const s=net.createServer();",
    "s.on('error',(e)=>{console.error(e.message);process.exit(1)});",
    "s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})"
  ].join('');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  return Number(String(out).trim());
}

export const E2E_PORT = Number(process.env.E2E_PORT || 0) || pickFreePort();
export const E2E_TOKEN = 'e2e-console-token-2026-10';
export const E2E_GROUP = '123456';
export const E2E_PLUGIN_ID = 'browser-fixture';
