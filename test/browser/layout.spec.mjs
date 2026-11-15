/* global document */
import { test, expect } from '@playwright/test';
import { login, switchTo } from './helpers.mjs';

test('设置卡片间距一致：聊天页所有卡片 16px，旧分隔线不再参与布局', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.waitForSelector('.settings-menu-item[data-section]');
  await page.locator('.settings-menu-item[data-section="chat"]').click();
  await page.waitForTimeout(250);
  const result = await page.evaluate(() => {
    const form = document.querySelector('#settings-form');
    const cards = [...form.querySelectorAll('.settings-card')].filter((card) => card.offsetParent !== null);
    const gaps = [];
    for (let i = 1; i < cards.length; i += 1) {
      gaps.push(Math.round(cards[i].getBoundingClientRect().top - cards[i - 1].getBoundingClientRect().bottom));
    }
    return { gaps: [...new Set(gaps)], dividers: form.querySelectorAll('.settings-divider').length };
  });
  expect(result.dividers, '设置页不应残留旧分隔线（会额外叠出 22px×2 间距）').toBe(0);
  expect(result.gaps, `聊天设置卡片间距应统一为 16px，实际 ${result.gaps.join('/')}`).toEqual([16]);
});

test('窄屏/平板 390/700px：设置分区不被长标签/按钮撑出横向溢出', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.waitForSelector('.settings-menu-item[data-section]');
  const sections = await page.locator('.settings-menu-item[data-section]')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.section));
  const bad = [];
  for (const width of [390, 700]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const section of sections) {
      if (section === 'token-saver') continue; // 明细表本身是可横向滚动的 .table-wrap
      await page.locator(`.settings-menu-item[data-section="${section}"]`).click();
      await page.waitForTimeout(160);
      const overflow = await page.evaluate(() => {
        const form = document.querySelector('#settings-form');
        return form.scrollWidth > form.clientWidth + 1;
      });
      if (overflow) bad.push(`${width}:${section}`);
    }
  }
  expect(bad, `这些分区出现横向溢出：${bad.join(', ')}`).toEqual([]);
});
