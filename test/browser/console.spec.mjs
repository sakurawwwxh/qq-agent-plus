/* global document, getComputedStyle */
import { test, expect } from '@playwright/test';
import { E2E_PLUGIN_ID, E2E_TOKEN } from './constants.mjs';
import { collectPageErrors, login, switchTo, tabNames } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

test('登录：错 Token 留在登录框，对 Token 进入总览，?token= 自动登录后清理 URL', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#console-login')).toBeVisible();

  await page.fill('#console-token', 'definitely-wrong-token');
  await page.click('#console-login-form button[type="submit"]');
  await expect(page.locator('#console-login-error')).toContainText(/Token|不正确/);

  await page.fill('#console-token', E2E_TOKEN);
  await page.click('#console-login-form button[type="submit"]');
  await expect(page.locator('#view-overview')).toHaveClass(/active/);
  await expect(page.locator('#console-login')).toBeHidden();
});

test('?token= 自动登录后把 Token 从地址栏移除', async ({ page }) => {
  await page.goto(`/?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page.locator('#view-overview')).toHaveClass(/active/);
  await expect.poll(() => new URL(page.url()).searchParams.get('token')).toBeNull();
});

test('?token= 登录比启动请求慢时也不弹登录框（远程/隧道场景回归）', async ({ page }) => {
  // 真实复现：经 SSH 隧道访问时，登录 POST 的往返比页面启动的第一批 API 请求慢，
  // 那些请求先拿到 401 就会把登录框弹出来；登录成功后旧实现也不会把它关掉，
  // 用户明明带了令牌却要再输一遍。
  await page.route('**/api/login', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const unauthorized = [];
  page.on('response', (response) => {
    if (response.status() === 401) unauthorized.push(new URL(response.url()).pathname);
  });
  await page.goto(`/?token=${encodeURIComponent(E2E_TOKEN)}`);
  // 等自动登录真正落地：地址栏令牌被抹掉 = POST /api/login 已经成功
  await expect.poll(() => new URL(page.url()).searchParams.get('token'), { timeout: 10000 }).toBeNull();
  await expect(page.locator('#view-overview')).toHaveClass(/active/);
  await expect(page.locator('#console-login')).toBeHidden();
  expect(unauthorized, `启动期不应出现 401：${unauthorized.join(', ')}`).toEqual([]);
});

test('config.json 外部修改提示：显示备份横幅，点击可关闭', async ({ page }) => {
  // 先真实取一份 status，再在路由里直接返回改过的 JSON；不要在 route 里 fetch。
  // 页面会轮询 /api/status，route.fetch 的慢响应会在用例结束后仍处于在途，
  // 下一个用例就收到 "Response has been disposed"/"Test ended"。
  await login(page);
  const status = await page.request.get('/api/status');
  expect(status.ok(), `status failed: HTTP ${status.status()}`).toBeTruthy();
  const body = await status.json();
  body.configConflict = { at: Date.now(), backupPath: 'C:/data/config.json.conflict-1-2.bak' };
  await page.route('**/api/status', (route) => route.fulfill({ json: body }));
  await page.goto('/');
  const banner = page.locator('#config-conflict-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('配置曾被外部修改');
  await banner.click();
  await expect(banner).toHaveCount(0);
  await page.unroute('**/api/status');
});

test('配置冲突保存：弹出三选一，取消后不写盘', async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({
      status: 409,
      json: {
        ok: false, code: 'CONFIG_CONFLICT', error: 'config.json 已被外部修改',
        configConflict: { at: Date.now(), backupPath: 'C:/data/config.json.conflict-1-2.bak' }
      }
    });
  });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="chat"]');
  await page.click('#save-cfg-btn');
  const dialog = page.locator('.model-modal');
  await expect(dialog).toContainText('配置文件已被外部修改');
  await expect(dialog.locator('[data-conflict-overwrite]')).toBeVisible();
  await dialog.locator('[data-conflict-cancel]').click();
  await expect(page.locator('.model-modal')).toHaveCount(0);
  await page.unroute('**/api/config');
});

test('15 个页签逐一切换，且没有 console error / pageerror', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.goto('/');
  await expect(page.locator('#view-overview')).toHaveClass(/active/);

  const tabs = await tabNames(page);
  expect(tabs).toHaveLength(15);

  for (const tab of tabs) {
    await switchTo(page, tab);
    await page.waitForTimeout(80);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('设置保存：改发送频率后落盘，再还原', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="chat"]');

  const input = page.locator('#cfg-maxpermin');
  await expect(input).toBeVisible();
  await input.fill('81');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).send.maxPerMinute;
  await expect.poll(read).toBe(81);

  await input.fill('80');
  await page.click('#save-cfg-btn');
  await expect.poll(read).toBe(80);
});

test('私聊文本文件：默认关闭、保存回显、关闭回退与窄屏显示', async ({ page }) => {
  const errors = collectPageErrors(page);
  // 测试服务不连接真实 QQ；此页附带的音色目录用只读桩，配置保存仍走真实接口。
  await page.route('**/api/onebot/ai-characters', (route) => route.fulfill({ json: { characters: [] } }));
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="platform"]');
  const checkbox = page.locator('#cfg-platform-privatefilesend');
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toHaveAttribute('aria-describedby', 'cfg-platform-privatefilesend-note');
  const note = page.locator('#cfg-platform-privatefilesend-note');
  await expect(note).toContainText('64 KiB');
  await expect(note).toContainText('TXT/MD/CSV/JSON');
  await expect(note).toContainText('当前私聊');
  await expect(note).toContainText('投递结果未知时需人工核对');
  const size = page.locator('#cfg-platform-privatefilemaxkib');
  await expect(size).toHaveValue('64');
  await expect(size).toHaveAttribute('min', '1');
  await expect(size).toHaveAttribute('max', '256');
  const read = async () => (await (await page.request.get('/api/config')).json()).platform.privateFileSend;
  for (const enabled of [true, false]) {
    await checkbox.setChecked(enabled);
    await page.click('#save-cfg-btn');
    await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');
    await expect.poll(read).toBe(enabled);
    await page.reload();
    await switchTo(page, 'settings');
    await page.click('.settings-menu-item[data-section="platform"]');
    await expect(checkbox).toBeChecked({ checked: enabled });
  }
  await expect(page.locator('#pergroup-privateFileSend')).toHaveCount(0);
  const readSize = async () => (await (await page.request.get('/api/config')).json()).platform.privateFileMaxKiB;
  for (const limit of [128, 256, 64]) {
    await size.fill(String(limit));
    await page.click('#save-cfg-btn');
    await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');
    await expect.poll(readSize).toBe(limit);
    await page.reload();
    await switchTo(page, 'settings');
    await page.click('.settings-menu-item[data-section="platform"]');
    await expect(size).toHaveValue(String(limit));
    await expect(checkbox).not.toBeChecked();
  }
  await checkbox.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/private-text-file-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkbox.scrollIntoViewIfNeeded();
  await expect(checkbox).toBeVisible();
  await expect(note).toBeVisible();
  await page.screenshot({ path: 'test-results/private-text-file-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('图片生成：自定义请求参数保存后回显', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');

  const area = page.locator('#cfg-img-extra-body');
  await expect(area).toBeAttached();
  await area.fill('{"output_watermark": {"enabled": false}}');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).imageGen.extraBody;
  await expect.poll(read).toEqual({ output_watermark: { enabled: false } });

  await page.reload();
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');
  // 回显是格式化后的 JSON（多行缩进），按解析后的对象比对，别用紧凑字符串正则
  const echoed = await page.locator('#cfg-img-extra-body').inputValue();
  expect(JSON.parse(echoed)).toEqual({ output_watermark: { enabled: false } });

  // 生成后发送格式（issue #67）：默认表情，可切普通图片；切换后落盘
  await expect(page.locator('#cfg-img-send-as')).toHaveValue('sticker');
  await page.selectOption('#cfg-img-send-as', 'image');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');
  await expect.poll(async () => (await (await page.request.get('/api/config')).json()).imageGen.sendAs).toBe('image');
});

test('技能页：渲染内置技能并可全局启停', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'skills');
  await expect(page.locator('#skills-page')).toBeVisible();
  await page.click('[data-skills-view="installed"]');
  await expect(page.locator('#skills-list')).toContainText('群聊总结');
  await page.click('[data-skill-open="chat-summary"]');
  await expect(page.locator('#skills-detail')).toBeVisible();
  await page.click('[data-skill-back]');
  await expect(page.locator('#skills-list')).toBeVisible();

  const toggle = page.locator('#skills-enabled');
  await expect(toggle).toHaveCSS('width', '44px');
  const readEnabled = async () => (await (await page.request.get('/api/skills')).json()).enabled;
  await expect.poll(readEnabled).toBe(true);
  await toggle.click();
  await expect.poll(readEnabled).toBe(false);
  await toggle.click();
  await expect.poll(readEnabled).toBe(true);

  await page.click('[data-skills-view="publish"]');
  await expect(page.locator('#skills-publish-view')).toBeVisible();
  await expect(page.locator('#skills-publish-view')).toContainText('提交一个技能');
});

test('技能市场：预览、安装、已安装列表与卸载', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'skills');
  await page.click('[data-skills-view="market"]');
  await expect(page.locator('#skills-market-view')).toContainText('出行规划');
  await expect(page.locator('.skills-market-pagination')).toBeVisible();
  await page.click('[data-market-page="next"]');
  await expect(page.locator('.skills-market-page.is-on')).toHaveText('2');
  await page.click('[data-market-page="prev"]');

  await page.click('[data-market-open="trip-planner"]');
  await expect(page.locator('.skills-market-preview')).toContainText('目标：');
  await page.click('[data-market-install="trip-planner"]');
  await page.click('[data-confirm-accept]');

  await page.click('[data-skills-view="installed"]');
  await expect(page.locator('#skills-list')).toContainText('出行规划');
  await page.click('[data-skill-open="trip-planner"]');
  await expect(page.locator('#skills-detail')).toContainText('出行规划');
  await page.click('[data-skill-uninstall="trip-planner"]');
  await page.click('[data-confirm-accept]');
  await expect(page.locator('#skills-list')).not.toContainText('出行规划');
});

test('插件详情在打开过技能市场后仍占满主区（回归：同名 .plugin-layout 抢走 is-detail）', async ({ page }) => {
  await login(page);
  await page.goto('/');
  // 技能市场与插件页共用 .plugin-layout/.plugin-toolbar，且 #view-skills 在 DOM 里更靠前。
  // 先把它渲染出来，才能复现"详情落在 190px 列里"的布局串台。
  await switchTo(page, 'skills');
  await expect(page.locator('#skills-page .plugin-layout')).toHaveCount(1);

  await switchTo(page, 'plugins');
  await page.click('[data-plugin-pane="installed"]');
  await page.locator('#plugins-installed [data-plugin-open]').first().click();
  await expect(page.locator('#plugins-page .plugin-detail')).toBeVisible();
  await expect(page.locator('#plugins-page .plugin-layout')).toHaveClass(/is-detail/);
  await expect(page.locator('#skills-page .plugin-layout')).not.toHaveClass(/is-detail/);

  const widths = await page.evaluate(() => ({
    detail: document.querySelector('#plugins-page .plugin-detail')?.getBoundingClientRect().width || 0,
    main: document.querySelector('#plugins-page .plugin-main')?.getBoundingClientRect().width || 0
  }));
  expect(widths.detail).toBeGreaterThan(500);
  expect(widths.main).toBeGreaterThan(500);
});

test('控制页：运行指标与最近审计可加载', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'control');
  await page.click('#control-observability-refresh');
  await expect(page.locator('#control-observability')).toContainText('进程 RSS');
  await expect(page.locator('#control-observability')).not.toContainText('读取失败');
  await expect(page.locator('#control-backup-status')).toContainText('目录：');
  await expect(page.locator('#control-backup-status')).not.toContainText('读取失败');
  await expect(page.locator('#control-group-policy')).not.toContainText('正在读取');
  await expect(page.locator('#control-group-policy')).not.toContainText('读取失败');
});

test('会话页：搜索、状态和模式筛选可用', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'sessions');
  await expect(page.locator('#session-search')).toBeVisible();
  await page.fill('#session-search', '不存在的会话');
  await page.selectOption('#session-filter-status', 'done');
  await page.selectOption('#session-filter-mode', 'legacy');
  await expect(page.locator('#session-more')).toBeAttached();
});

test('人物记忆：控制台按关键词检索记忆', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'people-memory');
  await page.fill('#gm-search-query', '面馆');
  await page.click('#gm-search-btn');
  await expect(page.locator('#gm-search-results')).toContainText('面馆');
});

test('长期记忆页：四个页签、记忆详情与召回测试可用', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'living-memory');
  await expect(page.locator('#living-memory-page h2')).toHaveText('长期记忆');
  await expect(page.locator('#lm-enabled')).toBeChecked();
  await expect(page.locator('#lm-shadow-semantic')).toBeAttached();
  await expect(page.locator('#lm-turn-retention')).toHaveValue('7');
  await expect(page.locator('#lm-status-filter')).toBeAttached();

  await page.click('[data-lm-tab="memories"]');
  await expect(page.locator('#lm-memory-list')).toContainText('NAS 迁移计划');

  // 键盘焦点在行内「归档」上时，Enter 应触发归档确认，而不是打开详情。
  const archive = page.locator('.lm-memory-row [data-lm-archive]').first();
  await archive.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-confirm-accept]')).toBeVisible();
  await page.click('[data-confirm-cancel]');
  await expect(page.locator('.lm-detail-card')).toHaveCount(0);

  await page.locator('.lm-memory-row', { hasText: 'NAS 迁移计划' }).click();
  await expect(page.locator('.lm-detail-card h3')).toHaveText('NAS 迁移计划');
  await page.click('[data-lm-back]');
  await expect(page.locator('#lm-memory-list')).toContainText('NAS 迁移计划');

  await page.click('[data-lm-tab="recall"]');
  await expect(page.locator('#lm-test')).toHaveText('测试召回');
  await page.fill('#lm-query', 'NAS 迁移备份');
  await page.click('#lm-test');
  await expect(page.locator('#lm-recall-result')).toContainText('NAS 迁移计划');

  await page.click('[data-lm-tab="settings"]');
  await expect(page.locator('#lm-enabled')).toBeVisible();
});

test('设置 → 实验功能：长期记忆卡片显示状态并可进入/取消固化', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('button[data-section="experiments"]');
  await expect(page.locator('#experiment-living-memory')).toBeVisible();
  await expect(page.locator('#living-memory-badge')).toHaveText('已固化');
  await expect(page.locator('#living-memory-state')).toContainText('运行中');
  await expect(page.locator('#lm-ungraduate')).toBeVisible();
  await expect(page.locator('#launch-living-memory-feature')).toHaveCount(0);
  await expect(page.locator('#lm-open-console')).toBeVisible();

  // 开关不应触发整页重绘（否则卡片会消失再出现）：先记下节点，再切换两次。
  await page.evaluate(() => { globalThis.__lmCard = document.querySelector('#experiment-living-memory'); });
  const enabled = page.locator('#cfg-living-memory-enabled');
  const readEnabled = async () => (await (await page.request.get('/api/config')).json()).livingMemory.enabled;
  await enabled.click();
  await expect.poll(readEnabled).toBe(false);
  await expect(page.locator('#living-memory-state')).toContainText('已停用');
  expect(await page.evaluate(() => globalThis.__lmCard === document.querySelector('#experiment-living-memory'))).toBe(true);
  await enabled.click();
  await expect.poll(readEnabled).toBe(true);
  await expect(page.locator('#living-memory-state')).toContainText('运行中');
  expect(await page.evaluate(() => globalThis.__lmCard === document.querySelector('#experiment-living-memory'))).toBe(true);

  await page.click('#lm-open-console');
  await expect(page.locator('#living-memory-page h2')).toHaveText('长期记忆');

  // 取消固化：同时关闭开关并隐藏导航入口，记忆数据不清空。
  await switchTo(page, 'settings');
  await page.click('button[data-section="experiments"]');
  await page.click('#lm-ungraduate');
  await page.click('[data-confirm-accept]');
  const readFlags = async () => {
    const lm = (await (await page.request.get('/api/config')).json()).livingMemory;
    return { enabled: lm.enabled, graduated: lm.graduated };
  };
  await expect.poll(async () => (await readFlags()).graduated).toBe(false);
  await expect.poll(async () => (await readFlags()).enabled).toBe(false);
  await expect(page.locator('#launch-living-memory-feature')).toHaveText('固化上线');
  await expect(page.locator('#tabs .tab[data-tab="living-memory"]')).toHaveClass(/hidden/);

  // 还原，避免影响同一服务器上的后续用例。
  await page.request.post('/api/config', { data: { livingMemory: { enabled: true, graduated: true } } });
});

test('语音服务切换：豆包/MiMo 各自恢复上次保存的音色', async ({ page }) => {
  await login(page);
  const setTts = async (data) => {
    const response = await page.request.post('/api/config', { data: { tts: { enabled: true, ...data } } });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  await setTts({
    provider: 'doubao',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    voice: 'ICL_E2E_DOUBAO'
  });
  await setTts({
    provider: 'mimo',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'Chloe'
  });

  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');
  const service = page.locator('#cfg-tts-service');
  await expect(service.locator('option[value="mimo"]')).toHaveCount(1);
  await expect(service).toHaveValue('mimo');
  await expect(page.locator('#cfg-tts-voice')).toHaveValue('Chloe');

  await service.selectOption('doubao');
  await expect(page.locator('#cfg-tts-voice')).toHaveValue('ICL_E2E_DOUBAO');
  await service.selectOption('mimo');
  await expect(page.locator('#cfg-tts-voice')).toHaveValue('Chloe');

  // 自定义/自建没有内置模型：不能把 MiMo 的模型名原样留在框里
  await service.selectOption('custom');
  await expect(page.locator('#cfg-tts-model')).toHaveValue('');
});

test('图片生成切换预设：没有内置模型的预设不能沿用上一家的模型名', async ({ page }) => {
  await login(page);
  const saved = await page.request.post('/api/config', {
    data: {
      imageGen: {
        enabled: true,
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'Qwen/Qwen-Image'
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();

  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');
  const service = page.locator('#cfg-img-service');
  await expect(service.locator('option[value="modelscope"]')).toHaveCount(1);
  await expect(page.locator('#cfg-img-model')).toHaveValue('Qwen/Qwen-Image');

  await service.selectOption('modelscope');
  await expect(page.locator('#cfg-img-model')).toHaveValue('', { timeout: 3000 });
  await service.selectOption('siliconflow');
  await expect(page.locator('#cfg-img-model')).toHaveValue('Tongyi-MAI/Z-Image-Turbo');
});

test('兜底模型：控制台可见、可保存，Key 不回显', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');

  const enabled = page.locator('#cfg-fallback-enabled');
  await expect(enabled).toBeVisible();
  await expect(page.locator('#cfg-fallback-model')).toBeVisible();
  await page.fill('#cfg-fallback-baseurl', 'https://token-plan-cn.xiaomimimo.com/v1');
  await page.fill('#cfg-fallback-model', 'mimo-v2.6-flash');
  await page.fill('#cfg-fallback-apikey', 'fallback-e2e-key');
  await enabled.check();
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).api.fallback;
  await expect.poll(read).toMatchObject({
    enabled: true,
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.6-flash'
  });
  const saved = await read();
  expect(saved.apiKey).toBeUndefined();
  expect(saved.hasApiKey).toBe(true);
  expect(saved.keyHost).toBe('token-plan-cn.xiaomimimo.com');

  await page.reload();
  await switchTo(page, 'settings');
  await expect(page.locator('#cfg-fallback-model')).toHaveValue('mimo-v2.6-flash');
  await expect(page.locator('#cfg-fallback-apikey')).toHaveValue('******');
  // 「显示」必须真的取回已保存的 Key（曾经没有前端分支/后端端点，点了只会清空并说没存过）
  await page.click('#cfg-fallback-apikey-toggle');
  await expect(page.locator('#cfg-fallback-apikey')).toHaveValue('fallback-e2e-key');
  await page.click('#cfg-fallback-apikey-toggle');
  await expect(page.locator('#cfg-fallback-apikey')).toHaveValue('******');

  // 换主机但 Key 保持掩码：保存要当场拒绝，不能把旧 Key 留在新地址上
  await page.fill('#cfg-fallback-baseurl', 'https://api.example-other.com/v1');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toContainText('换了主机');
  expect((await read()).baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/v1');

  // 启用兜底却没模型 id：也不能谎报「已保存」
  await page.fill('#cfg-fallback-baseurl', 'https://token-plan-cn.xiaomimimo.com/v1');
  await page.fill('#cfg-fallback-model', '');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toContainText('模型 id');
});

test('生活层设置页可渲染、可保存，窄屏无横向溢出', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="life-feed"]');

  await expect(page.locator('#settings-lifefeed')).toBeVisible();
  await expect(page.locator('#lifefeed-status')).toContainText('未开启');

  const interval = page.locator('#cfg-lifefeed-interval');
  await expect(interval).toHaveValue('360');
  await interval.fill('300');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).lifeFeed.forageIntervalMinutes;
  await expect.poll(read).toBe(300);

  const shareMode = page.locator('#cfg-lifefeed-sharemode');
  await expect(shareMode).toHaveValue('auto');
  await expect(page.locator('#cfg-lifefeed-sharegroups-box')).toBeVisible();
  await shareMode.selectOption('manual');
  await page.click('#save-cfg-btn');
  await expect.poll(async () => (await (await page.request.get('/api/config')).json()).lifeFeed.shareMode).toBe('manual');
  await shareMode.selectOption('auto');
  await page.click('#save-cfg-btn');
  await expect.poll(async () => (await (await page.request.get('/api/config')).json()).lifeFeed.shareMode).toBe('auto');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

  await interval.fill('360');
  await page.click('#save-cfg-btn');
  await expect.poll(read).toBe(360);
});

test('见闻分享目标：上百个群 + 好友在弹窗里搜索/筛选，字段只占一行', async ({ page }) => {
  const manyGroups = Array.from({ length: 120 }, (_, i) => ({ id: String(500000 + i), name: `测试群 ${i + 1}` }));
  await page.route('**/api/onebot/groups', (route) => route.fulfill({ json: { groups: manyGroups } }));
  await page.route('**/api/onebot/friends', (route) => route.fulfill({
    json: { friends: [{ id: '2001', name: '阿明' }, { id: '2002', name: '小红' }] }
  }));
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="life-feed"]');

  const box = page.locator('#cfg-lifefeed-sharegroups-box');
  await expect(box.locator('.session-picker-btn')).toBeVisible();
  // 字段只占一行：不再把几百行清单铺在设置页里（旧实现的左右两栏还会一高一空）。
  const fieldHeight = await box.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(fieldHeight).toBeLessThan(90);

  await box.locator('.session-picker-btn').click();
  const modal = page.locator('.session-picker-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.session-picker-row')).toHaveCount(122);

  // 弹窗里的列表自身滚动，高度受 modal 的 70vh 约束。
  const listMetrics = await modal.locator('.session-picker-list').evaluate((el) => ({
    height: Math.round(el.getBoundingClientRect().height),
    scrollHeight: el.scrollHeight
  }));
  expect(listMetrics.height).toBeLessThan(520);
  expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.height);
  const modalHeightBefore = await modal.evaluate((el) => Math.round(el.getBoundingClientRect().height));

  // 类型页签：只看私聊 → 2 条；再按群号搜索 → 1 条。
  await modal.locator('.session-picker-tab[data-tab="private"]').click();
  await expect(modal.locator('.session-picker-row')).toHaveCount(2);
  await modal.locator('.session-picker-tab[data-tab="all"]').click();
  await modal.locator('.session-picker-search').fill('500119');
  await expect(modal.locator('.session-picker-row')).toHaveCount(1);
  // 回归（用户反馈）：筛到只剩一行时弹窗不能跟着缩小，否则整块会往上跳。
  const modalHeightAfter = await modal.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(Math.abs(modalHeightAfter - modalHeightBefore)).toBeLessThanOrEqual(2);
  await modal.locator('.session-picker-cancel').click();
  await expect(modal).toHaveCount(0);
});

test('见闻分享目标：好友接口不可用时，私聊页签明确提示读取失败', async ({ page }) => {
  await page.route('**/api/onebot/groups', (route) => route.fulfill({ json: { groups: [{ id: '1001', name: '测试群' }] } }));
  await page.route('**/api/onebot/friends', (route) => route.fulfill({ status: 502, json: { error: 'get_friend_list 不可用' } }));
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="life-feed"]');

  await page.locator('#cfg-lifefeed-sharegroups-box .session-picker-btn').click();
  const modal = page.locator('.session-picker-modal');
  await expect(modal.locator('.session-picker-row')).toHaveCount(1);
  await modal.locator('.session-picker-tab[data-tab="private"]').click();
  await expect(modal.locator('.session-picker-empty')).toContainText('好友列表读取失败');
  await expect(modal.locator('.session-picker-tip')).toContainText('好友读取失败');
  await modal.locator('.session-picker-cancel').click();
});

test('见闻分享目标：弹窗里勾选私聊保存后回写 private:<QQ>，再清空还原', async ({ page }) => {
  await page.route('**/api/onebot/groups', (route) => route.fulfill({ json: { groups: [{ id: '1001', name: '测试群' }] } }));
  await page.route('**/api/onebot/friends', (route) => route.fulfill({ json: { friends: [{ id: '2001', name: '阿明' }] } }));
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="life-feed"]');

  const box = page.locator('#cfg-lifefeed-sharegroups-box');
  await box.locator('.session-picker-btn').click();
  const modal = page.locator('.session-picker-modal');
  await modal.locator('input.session-pick[value="private:2001"]').check();
  await modal.locator('.session-picker-ok').click();
  await expect(box.locator('.session-picker-count')).toContainText('已选 1 个');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).lifeFeed.shareGroups;
  await expect.poll(read).toEqual(['private:2001']);

  // 清空也要走弹窗（确定后才算用户编辑过），再保存回空。
  await page.locator('#cfg-lifefeed-sharegroups-box .session-picker-btn').click();
  await page.locator('.session-picker-none').click();
  await page.locator('.session-picker-ok').click();
  await page.click('#save-cfg-btn');
  await expect.poll(read).toEqual([]);
});

test('见闻手动分享下拉：白名单里的私聊也能选', async ({ page }) => {
  await login(page);
  const before = (await (await page.request.get('/api/config')).json()).allow.private;
  await page.request.post('/api/config', { data: { allow: { private: ['2001'] } } });
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="life-feed"]');
  await expect(page.locator('#cfg-lifefeed-chat option[value="private:2001"]')).toHaveCount(1);
  await page.request.post('/api/config', { data: { allow: { private: before } } });
});

test('生活层候选卡片：真实长文/多标签在 390px 下不溢出，操作条不出卡', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="life-feed"]');
  await expect(page.locator('#settings-lifefeed')).toBeVisible();

  const keys = await page.evaluate(async () => {
    const { groupKeys } = await import('/pages/life-feed.js');
    return groupKeys(['123', 'group:456', ' 789 ', 'weird']);
  });
  expect(keys).toEqual(['group:123', 'group:456', 'group:789', 'weird']);

  const cardCount = await page.evaluate(async () => {
    const { candidateCard } = await import('/pages/life-feed.js');
    const items = [
      {
        id: 'BVlong', source: 'bilibili', cover: '',
        title: '一个非常长的标题用来检查两行截断是否生效以及会不会把右侧操作按钮挤出去或者把卡片撑破导致横向滚动条出现',
        up: '一个名字也不短的 UP 主', play: 1234567, duration: 3660, score: 42,
        desc: '这是一段同样很长的简介，用来检查两行截断。里面故意放了很多字，确保在窄屏下正文不会把卡片撑宽，也不会把底部操作条推到卡片外面。',
        tags: ['深海', '潜水', '第一视角', '户外', '长标签测试', '再来一个'],
        url: 'https://www.bilibili.com/video/BVlong', offeredAt: 1
      },
      { id: 'BVempty', source: 'rss', title: '没有封面也没有摘要', url: 'https://example.com/a', tags: [] }
    ];
    const list = document.querySelector('#lifefeed-candidates');
    list.innerHTML = items.map(candidateCard).join('');
    return list.querySelectorAll('.feed-card').length;
  });
  expect(cardCount).toBe(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const metrics = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#lifefeed-candidates .feed-card')];
    return {
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cards: cards.map((card) => {
        const box = card.getBoundingClientRect();
        const actions = card.querySelector('.feed-card-actions').getBoundingClientRect();
        return {
          overflow: card.scrollWidth - card.clientWidth,
          actionsInside: actions.left >= box.left - 1 && actions.right <= box.right + 1
        };
      })
    };
  });
  expect(metrics.docOverflow).toBeLessThanOrEqual(1);
  for (const card of metrics.cards) {
    expect(card.overflow).toBeLessThanOrEqual(1);
    expect(card.actionsInside).toBe(true);
  }
});

test('好友设置保存：改入站待批上限后落盘，再还原', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'friends');

  const input = page.locator('#cfg-identity-incoming-max-pending');
  await expect(input).toBeVisible();
  await input.fill('51');
  await page.click('#friend-feature-save');

  const read = async () => {
    const cfg = await (await page.request.get('/api/config')).json();
    return cfg.identityPilot?.incomingFriendRequest?.maxPending;
  };
  await expect.poll(read).toBe(51);

  await page.locator('#cfg-identity-incoming-max-pending').fill('50');
  await page.click('#friend-feature-save');
  await expect.poll(read).toBe(50);
});

test('插件目录：索引超过一页时分页', async ({ page }) => {
  const plugins = Array.from({ length: 30 }, (_, index) => ({
    id: `demo-${String(index + 1).padStart(2, '0')}`,
    name: `测试插件 ${String(index + 1).padStart(2, '0')}`,
    description: '分页回归用条目',
    version: '1.0.0',
    author: 'tester',
    category: '测试',
    tags: ['test'],
    capabilities: ['tools'],
    compatible: true,
    downloads: index,
    updatedAt: '2026-10-01'
  }));
  await page.route('**/api/plugins/index', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ plugins, skipped: [], sources: [{ name: '测试索引', ok: true, count: plugins.length }] })
  }));
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await expect(page.locator('.plugin-pagination')).toBeVisible();
  await page.click('[data-plugin-page="next"]');
  await expect(page.locator('.plugin-page.is-on')).toHaveText('2');
});

test('插件审批：待批请求能在插件详情里点「批准一次」', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await expect(page.locator('#plugins-page')).toBeVisible();

  await page.click('[data-plugin-pane="installed"]');
  // 顶部跨插件待批条：直接点进去，详情应自动滚到「待你批准」
  const banner = page.locator('#plugins-pending-banner');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText('待批');
  await banner.locator('[data-pending-jump="1"]').first().click();

  const block = page.locator(`[data-pd-settings="${E2E_PLUGIN_ID}"]`);
  await expect(block).toBeVisible({ timeout: 15_000 });
  await expect(block).toContainText('待你批准');
  await block.locator('[data-pd-approve-pending]').first().click();

  const read = async () => (await (await page.request.get(`/api/plugins/settings?id=${E2E_PLUGIN_ID}`)).json());
  await expect.poll(async () => (await read()).pending.length).toBe(0);
  const settings = await read();
  expect(settings.grants?.approvals?.write?.usesLeft ?? 0).toBeGreaterThan(0);
});

test('窄屏设置：切到屏外分区后当前项仍在可视范围内', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="experiments"]');
  const visible = await page.evaluate(() => {
    const menu = document.querySelector('#settings-sidebar .settings-menu');
    const active = menu?.querySelector('.settings-menu-item.active');
    if (!menu || !active) return false;
    const m = menu.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    return a.left >= m.left - 1 && a.right <= m.right + 1;
  });
  expect(visible).toBe(true);
});

test('窄屏 390×844：15 个页签都没有横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/');
  const tabs = await tabNames(page);
  expect(tabs).toHaveLength(15);

  const assertNoOverflow = async (label) => {
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll('body *')]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1);
        })
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className || '').replace(/\s+/g, '.')}`)
    }));
    expect(metrics.scrollWidth, `${label} 越界元素：${metrics.offenders.join(' | ')}`)
      .toBeLessThanOrEqual(metrics.clientWidth + 1);
  };

  for (const tab of tabs) {
    await switchTo(page, tab);
    await page.waitForTimeout(150);
    await assertNoOverflow(`tab=${tab}`);
  }

  // 设置页默认只量到 api 分区；逐个点开所有设置分区，覆盖本轮新增的聊天/空间/生活层/长期记忆入口。
  await switchTo(page, 'settings');
  const sections = await page.locator('.settings-menu-item[data-section]')
    .evaluateAll((items) => items.map((item) => item.dataset.section));
  for (const section of sections) {
    await page.locator(`.settings-menu-item[data-section="${section}"]`).click();
    await page.waitForTimeout(150);
    await assertNoOverflow(`settings/${section}`);
  }
});

test('设置表单：同一行的控件顶边对齐（标签换行不能把输入框挤下去）', async ({ page }) => {
  // 800 是窄屏但仍保留三轨的临界宽度：标签更容易换行，最容易暴露错位。
  for (const width of [800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await page.goto('/');
    await switchTo(page, 'settings');

    const sections = await page.locator('.settings-menu-item[data-section]')
      .evaluateAll((items) => items.map((item) => item.dataset.section));

    for (const section of sections) {
      await page.locator(`.settings-menu-item[data-section="${section}"]`).click();
      await page.waitForTimeout(150);
      const issues = await page.evaluate(() => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const found = [];
        const seen = new Set();
        for (const field of document.querySelectorAll('#settings-form .field')) {
          const parent = field.parentElement;
          if (!parent || seen.has(parent)) continue;
          seen.add(parent);
          const fields = [...parent.children]
            .filter((el) => el.classList?.contains('field') && visible(el));
          if (fields.length < 2) continue;
          // 同一 grid/flex 行里的字段：字段顶边相同，控件顶边也应相同。
          const groups = [];
          for (const item of fields) {
            const top = item.getBoundingClientRect().top;
            let group = groups.find((candidate) => Math.abs(candidate.top - top) <= 2);
            if (!group) {
              group = { top, items: [] };
              groups.push(group);
            }
            group.items.push(item);
          }
          for (const group of groups) {
            if (group.items.length < 2) continue;
            const controls = group.items.map((item) => {
              const label = item.querySelector(':scope > label');
              const control = item.querySelector(':scope > input, :scope > select, :scope > textarea');
              if (!label || !control || !visible(control)) return null;
              return {
                label: label.textContent.trim().replace(/\s+/g, ' ').slice(0, 40),
                id: control.id || control.className || '',
                top: control.getBoundingClientRect().top
              };
            }).filter(Boolean);
            if (controls.length < 2) continue;
            const tops = controls.map((item) => item.top);
            const delta = Math.max(...tops) - Math.min(...tops);
            if (delta > 2) {
              found.push({
                delta: Math.round(delta * 10) / 10,
                fields: controls.map((item) => `${item.label}${item.id ? ` (#${item.id})` : ''}`)
              });
            }
          }
        }
        return found;
      });
      expect(issues, `settings/${section} 控件错位：${JSON.stringify(issues)}`).toEqual([]);
    }
  }
});
