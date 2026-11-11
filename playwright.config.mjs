import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT } from './test/browser/constants.mjs';

// 把本次运行选中的端口传给 webServer 与 worker；否则 worker 重新导入
// constants 时会因为 process.pid 不同再挑一个端口。
process.env.E2E_PORT = String(E2E_PORT);

// 录像/trace 只在 CI 或显式 PW_CAPTURE=1 时采集：Windows 上 Chromium 带录像跑长序列
// 偶发 worker 崩溃（0xC0000409，STATUS_STACK_BUFFER_OVERRUN），会把后面 20+ 条用例一起带停。
// CI 是 Linux 且需要失败产物，保持采集不变。
const capture = Boolean(process.env.CI) || process.env.PW_CAPTURE === '1';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: capture ? 'retain-on-failure' : 'off',
    video: capture ? 'retain-on-failure' : 'off',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 900 }
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `http://127.0.0.1:${E2E_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ]
});
