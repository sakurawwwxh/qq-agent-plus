// 本机转写安装脚本的下载语义：慢但持续出数据不能因为"总时长"被掐掉；
// 卡住不动要按空闲超时中止并清掉半截文件（2026-09-26 审查：原来是 120 秒总预算，
// 默认 466MB 模型要求 ≈3.9MB/s，慢线路必然中途失败并白白轮换镜像）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { download } = await import('../scripts/install-asr-local.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = Buffer.alloc(1024, 7);

test('慢速但持续出数据：不因总时长被中断（按空闲超时判）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dl-fast-'));
  const dest = path.join(dir, 'model.bin');
  const slowFetch = async () => ({
    ok: true,
    headers: { get: () => String(chunk.length * 6) },
    body: (async function* () {
      for (let i = 0; i < 6; i += 1) { await sleep(120); yield chunk; }
    })()
  });
  const bytes = await download('https://example.invalid/model', dest, { idleMs: 400, fetchFn: slowFetch });
  assert.equal(bytes, chunk.length * 6, '整份下完');
  assert.ok(fs.existsSync(dest), '成品文件在');
  assert.equal(fs.existsSync(`${dest}.part`), false, '临时文件已改名');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('卡住不动：按空闲超时中止，并清掉半截文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dl-stall-'));
  const dest = path.join(dir, 'model.bin');
  const stalledFetch = async () => ({
    ok: true,
    headers: { get: () => '2048' },
    body: (async function* () {
      yield chunk;
      await new Promise(() => { /* 永远不再出数据 */ });
    })()
  });
  await assert.rejects(
    () => download('https://example.invalid/model', dest, { idleMs: 200, fetchFn: stalledFetch }),
    /卡住/
  );
  assert.equal(fs.existsSync(`${dest}.part`), false, '半截文件要清掉，别当成完整模型');
  assert.equal(fs.existsSync(dest), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('HTTP 失败：报状态码，不留下任何文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dl-http-'));
  const dest = path.join(dir, 'model.bin');
  const notFound = async () => ({ ok: false, status: 404, headers: { get: () => '' }, body: null });
  await assert.rejects(
    () => download('https://example.invalid/model', dest, { idleMs: 200, fetchFn: notFound }),
    /HTTP 404/
  );
  assert.equal(fs.existsSync(`${dest}.part`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
