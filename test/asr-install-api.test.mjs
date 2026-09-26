// 「在控制台点一下装本机语音转写」的接口：起安装、看进度、装完把路径写进配置并**在进程内生效**
// （配置只在启动时读一次，没有文件监听 —— 不重读就会"装完了却没反应"，这是实测踩到的坑）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-asr-install-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, getConfig, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 假安装器：模拟"构建 + 下载 + 产物就位"，并打印带百分比的进度行。 */
function writeFakeInstaller(file) {
  fs.writeFileSync(file, `
    const fs = require('node:fs');
    const path = require('node:path');
    const i = process.argv.indexOf('--data-dir');
    const dataDir = process.argv[i + 1];
    const target = path.join(dataDir, 'asr');
    console.log('· 拉取 whisper.cpp 源码…');
    fs.mkdirSync(path.join(target, 'whisper.cpp', 'build', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(target, 'whisper.cpp', 'build', 'bin', 'whisper-cli'), '#!/bin/sh\\n');
    console.log('· 下载模型（fake）…');
    process.stdout.write('\\r  下载中 1.0MB 12.5%   ');
    fs.writeFileSync(path.join(target, 'ggml-tiny.bin'), 'x');
    process.stdout.write('\\r  下载中 8.0MB 100.0%   ');
    console.log('');
    console.log('· 装好了');
  `);
}

test('控制台一键安装：状态流转、重复触发被拒、装完自动写配置并生效', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.asr = { ...cfg.asr, provider: 'local', enabled: true, localBin: '', localModel: '' };
  updateConfig(cfg);
  const installer = path.join(root, 'fake-installer.cjs');
  writeFakeInstaller(installer);
  const app = createApp({ log: () => {}, asrInstaller: installer });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const request = async (route, { method = 'GET' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method });
    return { status: response.status, body: await response.json() };
  };

  const before = await request('/api/asr/install-status');
  assert.equal(before.status, 200);
  assert.equal(before.body.running, false);
  assert.equal(before.body.installed, false, '还没装：两样都没有');

  const started = await request('/api/asr/install', { method: 'POST' });
  assert.equal(started.status, 202);
  // 同一时间只允许一个：立刻再点应被拒
  const again = await request('/api/asr/install', { method: 'POST' });
  assert.ok([202, 409].includes(again.status), '要么已经跑完（极快），要么被 409 拒掉');
  if (again.status === 409) assert.match(again.body.error, /已经有一个安装/);

  // 等它跑完（假安装器很快）
  for (let i = 0; i < 100; i += 1) {
    const st = await request('/api/asr/install-status');
    if (!st.body.running) {
      assert.equal(st.body.ok, true, `安装应成功：${st.body.error}`);
      assert.equal(st.body.installed, true, '装完状态应变成已安装');
      assert.match(st.body.resolved.bin, /whisper-cli$/, '解析到假安装器的二进制');
      assert.match(st.body.resolved.model, /ggml-tiny\.bin$/, '解析到假安装器的模型');
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // 装完自动写进配置，而且**当前进程**立刻用它（不用重启）
  const live = getConfig();
  assert.equal(live.asr.provider, 'local');
  assert.match(String(live.asr.localBin), /whisper-cli$/);
  assert.match(String(live.asr.localModel), /ggml-tiny\.bin$/);
  const status = await request('/api/config');
  assert.equal(status.body.asr.available, true, '接口也应立刻报告"可用"');

  // 已安装后再点：不该重复构建（安装器是幂等的，这里只要求能再跑通）
  const rerun = await request('/api/asr/install', { method: 'POST' });
  assert.ok([202, 409].includes(rerun.status));
});

test('停服时不留孤儿安装进程（重启后不会出现两个并行的构建）', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  updateConfig(cfg);
  // 慢安装器：3 秒后写一个"我跑完了"的标记；被中途杀掉就不该有这个文件
  const marker = path.join(root, 'slow-done.marker');
  const slow = path.join(root, 'slow-installer.cjs');
  fs.writeFileSync(slow, `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); }, 3000);`);
  const app = createApp({ log: () => {}, asrInstaller: slow });
  await app.start();
  const res = await fetch(`http://127.0.0.1:${port}/api/asr/install`, { method: 'POST' });
  assert.equal(res.status, 202);
  await app.stop();                              // 停服（等价于部署重启）
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(fs.existsSync(marker), false, '停服时应把安装子进程杀掉，不留孤儿');
  fs.rmSync(marker, { force: true });
  fs.rmSync(slow, { force: true });
});
