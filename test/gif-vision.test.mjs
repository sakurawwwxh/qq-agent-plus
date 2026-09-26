// GIF 视觉链路测试：GIF 不再以 image/gif 直塞给视觉模型（主流网关不收），
// 而是 ffmpeg 抽帧拼 2x2 帧条转成 JPEG；ffmpeg 缺失时回退原始 GIF（行为不劣化）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gif-vision-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.security = { ...cfg.security, allowPrivateImageHosts: true };
updateConfig(cfg);

const { convertGifToStillStrip, resolveFfmpeg } = await import('../src/tools/image-downsample.js');
const toolsCore = await import('../src/tools/tools-core.js');
const downloadImageAsDataUrl = toolsCore.downloadImageAsDataUrl;

const hasFfmpeg = await resolveFfmpeg() !== null;

// 1x1 GIF89a 常量：无 ffmpeg 或生成失败时兜底，保证服务端总有合法 GIF 可回
const TINY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** 用 ffmpeg 现场生成一段 2 秒的动画 GIF（testsrc 自带动感内容）。
 * 用异步 spawn 而非 spawnSync：Windows 上 spawnSync('ffmpeg') 会偶发 EBUSY（AV 扫描），
 * 异步 spawn 不受影响；连续失败重试 3 次。 */
async function makeAnimatedGif() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const gif = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc=duration=2:size=256x256:rate=10',
          '-frames:v', '20',
          '-f', 'gif', 'pipe:1'
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve(null);
        return;
      }
      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    });
    if (gif?.length) return gif;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

let server;
let port = 0;
let servedGif = null;

before(async () => {
  servedGif = hasFfmpeg ? await makeAnimatedGif() : TINY_GIF;
  // 有 ffmpeg 但 testsrc 生成失败（罕见瞬态）时也用常量小 GIF 兜底，
  // 让测试 2/3 断言的是"转换链路"而不是"生成环节"——失败信息更可读。
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/gif' });
    res.end(servedGif ?? Buffer.alloc(0));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('convertGifToStillStrip：动图 → JPEG 帧条（装了 ffmpeg 才断言）', async () => {
  if (!hasFfmpeg) return; // 无 ffmpeg 环境：回退路径由下一条覆盖
  const gif = await makeAnimatedGif();
  assert.ok(gif?.length, 'ffmpeg 应能生成测试 GIF');
  assert.equal(gif.toString('ascii', 0, 3), 'GIF', '源头确实是 GIF');
  const jpeg = await convertGifToStillStrip(gif);
  assert.ok(jpeg?.length, '应产出帧条');
  assert.equal(jpeg[0], 0xff, '产物应为 JPEG（FFD8 魔数）');
  assert.equal(jpeg[1], 0xd8, '产物应为 JPEG（FFD8 魔数）');
});

test('downloadImageAsDataUrl：网络 GIF → data:image/jpeg（不再产出 image/gif）', async () => {
  if (!hasFfmpeg) return;
  const dataUrl = await downloadImageAsDataUrl(`http://127.0.0.1:${port}/img`);
  assert.match(dataUrl, /^data:image\/jpeg;base64,/, 'GIF 应被转成 JPEG 帧条');
  assert.doesNotMatch(dataUrl, /^data:image\/gif/, '不应再把 image/gif 直接塞给视觉模型');
  const base64 = dataUrl.slice('data:image/jpeg;base64,'.length);
  assert.ok(Buffer.from(base64, 'base64').length > 1000, '帧条不应是空图');
});

test('base64:// 路径的 GIF 同样转 JPEG', async () => {
  if (!hasFfmpeg) return;
  const gif = await makeAnimatedGif();
  const dataUrl = await downloadImageAsDataUrl(`base64://${gif.toString('base64')}`);
  assert.match(dataUrl, /^data:image\/jpeg;base64,/);
});

test('ffmpeg 缺失时回退原始 GIF data URL（在"没有 ffmpeg"的子进程里验证）', () => {
  // 2026-09-26 审查：CI 装上 ffmpeg 之后，`if (hasFfmpeg) return` 让这条回退路径在 runner 上
  // 永远不会执行（而且 return 计入"通过"）。改成起一个 PATH 里没有 ffmpeg 的子进程来覆盖：
  // 无论跑测试的机器装没装 ffmpeg，这条生产回退路径都真的被测到。
  const mod = pathToFileURL(path.resolve('src/tools/tools-core.js')).href;
  const gif = TINY_GIF.toString('base64');
  const script = `
    const { downloadImageAsDataUrl } = await import(${JSON.stringify(mod)});
    const out = await downloadImageAsDataUrl('base64://' + ${JSON.stringify(gif)});
    if (!out.startsWith('data:image/gif;base64,')) { console.error('NOT_FALLBACK:' + out.slice(0, 32)); process.exit(3); }
    console.log('FALLBACK_OK');
  `;
  const empty = path.join(os.tmpdir(), 'qq-no-ffmpeg-path');
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: empty, Path: empty, QQ_AGENT_DATA_DIR: dataDir },
    encoding: 'utf8'
  });
  assert.equal(res.status, 0, `子进程应成功回退：${res.stderr || res.stdout}`);
  assert.match(res.stdout, /FALLBACK_OK/);
});
