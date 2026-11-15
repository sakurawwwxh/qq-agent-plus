/* global document, window */
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('replacement editor: four independent queues, 3 empty slots, all-model picker, add/clear/remove, save and reload', async ({ page }, testInfo) => {
  const errors = collectPageErrors(page);
  await login(page);
  const initial = await (await page.request.get('/api/config')).json();
  const providers = ['A','B','C','D'].map((id) => ({ id: `chain_${id}`, displayName: `测试服务 ${id}`, baseURL: `https://${id.toLowerCase()}.example/v1`, models: [`model-${id}`, `extra-${id}`] }));
  const seeded = await page.request.post('/api/config', { data: {
    providers, providerKeys: Object.fromEntries(providers.map((p) => [p.id, `fake-key-${p.id}`])),
    api: { provider: 'chain_D', model: 'model-D', baseUrl: 'https://d.example/v1' }
  } });
  expect(seeded.ok()).toBeTruthy();
  try {
    await page.goto('/');await switchTo(page, 'settings');
    await expect(page.locator('#settings-model-replacement')).toBeVisible();
    expect(await page.locator('#settings-api').evaluate((el) => el.compareDocumentPosition(document.querySelector('#settings-model-replacement')) & 4)).toBeTruthy();
    expect(await page.locator('#settings-model-replacement').evaluate((el) => el.compareDocumentPosition([...document.querySelectorAll('h3')].find((h) => h.textContent === '兜底模型')) & 4)).toBeTruthy();
    await expect(page.locator('[data-replacement-channel]')).toHaveCount(4);
    for (const channel of ['chat','asr','tts','imageGen']) {
      await expect(page.locator(`[data-replacement-rows="${channel}"] input`)).toHaveCount(3);
      await expect(page.locator(`#replacement-${channel}-enabled`)).not.toBeChecked();
    }
    await page.locator('#replacement-chat-0').click();
    await expect(page.locator('.model-modal-overlay:not(.closing) #replacement-picker-left .mm-prov')).toHaveCount(4);
    await page.locator('.model-modal-overlay:not(.closing)').getByRole('button', { name: '测试服务 A', exact: true }).click();
    await expect(page.locator('.model-modal-overlay:not(.closing) #replacement-picker-right .mm-model')).toHaveCount(2);
    await page.locator('.model-modal-overlay:not(.closing) #replacement-picker-right [data-replacement-model="0"]').click();
    await expect(page.locator('#replacement-chat-0')).toHaveValue(/model-A/);
    await page.locator('[data-replacement-add="chat"]').click();
    await expect(page.locator('[data-replacement-rows="chat"] input')).toHaveCount(4);
    await page.locator('[data-replacement-channel="chat"] [data-replacement-remove="3"]').click();
    await expect(page.locator('[data-replacement-rows="chat"] input')).toHaveCount(3);
    await page.locator('#replacement-chat-1').click();
    await page.locator('.model-modal-overlay:not(.closing)').getByRole('button', { name: '测试服务 B', exact: true }).click();
    await page.locator('.model-modal-overlay:not(.closing) #replacement-picker-right [data-replacement-model="0"]').click();
    await page.locator('[data-replacement-channel="chat"] [data-replacement-clear="1"]').click();
    await expect(page.locator('#replacement-chat-1')).toHaveValue('');
    await page.locator('#replacement-chat-enabled').check();
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/model-replacement') && r.request().method() === 'POST');
    await page.locator('[data-replacement-save="chat"]').click();expect((await saved).ok()).toBeTruthy();
    await page.reload();await switchTo(page, 'settings');
    await expect(page.locator('#replacement-chat-enabled')).toBeChecked();
    await expect(page.locator('#replacement-chat-0')).toHaveValue(/model-A/);
    await expect(page.locator('#cfg-model-pick')).toHaveValue(/model-D/);
    await page.locator('#settings-model-replacement').scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.locator('#settings-model-replacement').locator('..').screenshot({ path: testInfo.outputPath('model-replacement-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#settings-model-replacement').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('model-replacement-mobile.png') });
    expect(errors).toEqual([]);
  } finally {
    const current = await (await page.request.get('/api/config')).json();
    const modelReplacement = Object.fromEntries(Object.entries(current.modelReplacement).map(([key, c]) => [key, { enabled: false, entries: [null,null,null], revision: c.revision }]));
    for (const [channel, chain] of Object.entries(modelReplacement)) await page.request.post('/api/model-replacement', { data: { channel, ...chain } });
    await page.request.post('/api/config', { data: { providers: initial.providers || [], api: { provider: initial.api.provider || '', model: initial.api.model, baseUrl: initial.api.baseUrl } } });
  }
});


test('independent saves: general save excludes chains, each queue saves only itself, conflicts preserve other drafts', async ({ page }) => {
  const errors = collectPageErrors(page);
  const channels = ['chat', 'asr', 'tts', 'imageGen'];
  await login(page);
  const read = async () => (await page.request.get('/api/config')).json();
  const initial = await read();
  const entry = (model) => ({ source: 'catalog', providerId: 'isolated_chain', model });
  const seeded = await page.request.post('/api/config', { data: {
    providers: [{ id: 'isolated_chain', displayName: '独立保存测试', baseURL: 'https://isolated.example/v1', models: ['A', 'B', 'C'] }],
    providerKeys: { isolated_chain: 'fake-key' },
    api: { provider: 'isolated_chain', baseUrl: 'https://isolated.example/v1', model: 'A' }
  } });
  expect(seeded.ok()).toBeTruthy();
  const saveViaApi = async (channel, entries, enabled = false) => {
    const cfg = await read();
    const result = await page.request.post('/api/model-replacement', { data: {
      channel, entries, enabled, revision: cfg.modelReplacement[channel].revision
    } });
    expect(result.ok()).toBeTruthy();
  };
  for (const channel of channels) await saveViaApi(channel, ['A', 'B', 'C'].map(entry));
  try {
    await page.goto('/'); await switchTo(page, 'settings');
    await expect(page.locator('[data-replacement-save]')).toHaveCount(4);
    const saveButtonColors = await page.locator('[data-replacement-save], #save-cfg-btn').evaluateAll((buttons) => buttons.map((button) => {
      const css = window.getComputedStyle(button);
      return { background: css.backgroundColor, color: css.color, border: css.borderColor };
    }));
    for (const colors of saveButtonColors) expect(colors).toEqual(saveButtonColors[0]);
    const pick = async (channel, modelIndex) => {
      const details = page.locator(`[data-replacement-channel="${channel}"]`);
      if (!await details.evaluate((el) => el.open)) await details.locator('summary').click();
      await page.locator(`#replacement-${channel}-0`).click();
      await page.locator(`.model-modal-overlay:not(.closing) #replacement-picker-right [data-replacement-model="${modelIndex}"]`).click();
    };
    for (const channel of channels) await pick(channel, 1);
    const beforeMainSave = await read();
    await page.locator('#cfg-temperature').fill('0.4');
    const mainResponse = page.waitForResponse((r) => r.url().endsWith('/api/config') && r.request().method() === 'POST');
    await page.locator('#save-cfg-btn').click();
    const main = await mainResponse;
    expect(main.ok()).toBeTruthy();
    expect(main.request().postDataJSON()).not.toHaveProperty('modelReplacement');
    expect((await read()).modelReplacement).toEqual(beforeMainSave.modelReplacement);
    for (const channel of channels) {
      await expect(page.locator(`#replacement-${channel}-0`)).toHaveValue(/^B/);
      await expect(page.locator(`[data-replacement-status="${channel}"]`)).toContainText('未保存');
    }
    await page.locator('#cfg-temperature').fill('0.6');
    for (const channel of channels) {
      const before = await read();
      const response = page.waitForResponse((r) => r.url().endsWith('/api/model-replacement') && r.request().method() === 'POST');
      await page.locator(`[data-replacement-save="${channel}"]`).click();
      const saved = await response;
      expect(saved.ok()).toBeTruthy();
      expect(Object.keys(saved.request().postDataJSON()).sort()).toEqual(['channel', 'enabled', 'entries', 'revision']);
      expect(saved.request().postDataJSON().channel).toBe(channel);
      await expect(page.locator(`[data-replacement-status="${channel}"]`)).toContainText('此链已保存');
      const after = await read();
      expect(after.modelReplacement[channel].entries[0]).toEqual(entry('B'));
      for (const other of channels.filter((c) => c !== channel)) expect(after.modelReplacement[other]).toEqual(before.modelReplacement[other]);
      expect(after.api.temperature).toBe(0.4);
      await expect(page.locator('#cfg-temperature')).toHaveValue('0.6');
      await expect(page.locator('#cfg-dirty-note')).toContainText('未保存');
    }
    // A no-op save after an earlier save must use the new revision, not a captured stale draft.
    const unchanged = (await read()).modelReplacement.chat;
    await page.locator('[data-replacement-save="chat"]').click();
    await expect(page.locator('[data-replacement-status="chat"]')).toContainText('此链已保存');
    expect((await read()).modelReplacement.chat).toEqual(unchanged);
    await pick('chat', 2); await pick('asr', 2);
    await saveViaApi('chat', ['A', 'C', 'B'].map(entry));
    const staleResponse = page.waitForResponse((r) => r.url().endsWith('/api/model-replacement') && r.request().method() === 'POST');
    await page.locator('[data-replacement-save="chat"]').click();
    expect((await staleResponse).status()).toBe(409);
    await expect(page.locator('[data-replacement-status="chat"]')).toContainText('本次未保存');
    await expect(page.locator('#replacement-chat-0')).toHaveValue(/^C/);
    await expect(page.locator('#replacement-asr-0')).toHaveValue(/^C/);
    await page.locator('[data-replacement-reload="chat"]').click();
    await page.locator('.model-modal-overlay:not(.closing) [data-confirm-accept]').click();
    await expect(page.locator('[data-replacement-status="chat"]')).toContainText('已重新读取');
    await expect(page.locator('#replacement-chat-0')).toHaveValue(/^A/);
    await expect(page.locator('#replacement-asr-0')).toHaveValue(/^C/);
    await expect(page.locator('#cfg-temperature')).toHaveValue('0.6');
    // Reloading just chat has not silently stored the ASR or ordinary drafts.
    expect((await read()).modelReplacement.asr.entries[0]).toEqual(entry('B'));
    expect((await read()).api.temperature).toBe(0.4);
    // Discarding the form via the existing confirmation also clears only its dirty markers.
    await page.locator('.settings-menu-item[data-section="appearance"]').click();
    await page.locator('.model-modal-overlay:not(.closing) [data-confirm-cancel]').click();
    await expect(page.locator('#replacement-asr-0')).toHaveValue(/^C/);
    await page.locator('.settings-menu-item[data-section="appearance"]').click();
    await page.locator('.model-modal-overlay:not(.closing) [data-confirm-accept]').click();
    await expect(page.locator('#settings-appearance')).toBeAttached();
    await page.locator('.settings-menu-item[data-section="api"]').click();
    await expect(page.locator('.model-modal-overlay:not(.closing) [data-confirm-accept]')).toHaveCount(0);
    expect(errors.filter((e) => !/409 \(Conflict\)/.test(e))).toEqual([]);
  } finally {
    for (const channel of channels) await saveViaApi(channel, [null, null, null]);
    await page.request.post('/api/config', { data: {
      providers: initial.providers || [], api: { provider: initial.api.provider || '', model: initial.api.model,
        baseUrl: initial.api.baseUrl, temperature: initial.api.temperature }
    } });
  }
});


test('one trigger editor: channel dropdown, isolated saves, preserved drafts and conflict protection', async ({ page }, testInfo) => {
  const errors = collectPageErrors(page);
  await login(page);
  const read = async () => (await page.request.get('/api/config')).json();
  const initial = await read();
  const channels = ['chat', 'asr', 'tts', 'imageGen'];
  const defaults = { http402: true, http403: true, quota429: true, http401: false };
  const entry = (model) => ({ source: 'catalog', providerId: 'trigger-test', model });
  await page.request.post('/api/config', { data: {
    providers: [{ id: 'trigger-test', displayName: '触发条件测试', baseURL: 'https://trigger.example/v1', models: ['A', 'B', 'C'] }],
    providerKeys: { 'trigger-test': 'fake-trigger-key' }
  } });
  const rules = async (channel, triggers) => page.request.post('/api/model-replacement', { data: {
    channel, triggers, revision: (await read()).modelReplacement[channel].revision
  } });
  for (const channel of channels) {
    const result = await page.request.post('/api/model-replacement', { data: {
      channel, enabled: false, entries: [entry('A'), entry('B')], revision: (await read()).modelReplacement[channel].revision
    } });
    expect(result.ok()).toBeTruthy(); expect((await rules(channel, defaults)).ok()).toBeTruthy();
  }
  try {
    await page.goto('/'); await switchTo(page, 'settings');
    await expect(page.locator('#replacement-trigger-editor')).toHaveCount(1);
    await expect(page.locator('[data-replacement-trigger]')).toHaveCount(4);
    await expect(page.locator('#replacement-trigger-channel option')).toHaveCount(4);
    for (const [key, checked] of Object.entries(defaults)) {
      if (checked) await expect(page.locator(`#replacement-trigger-${key}`)).toBeChecked();
      else await expect(page.locator(`#replacement-trigger-${key}`)).not.toBeChecked();
    }
    await page.locator('#replacement-trigger-http402').uncheck();
    await page.locator('#replacement-trigger-channel').selectOption('asr');
    await page.locator('#replacement-trigger-http403').uncheck();
    await page.locator('#replacement-trigger-http401').check();
    await page.locator('#replacement-trigger-channel').selectOption('chat');
    await expect(page.locator('#replacement-trigger-http402')).not.toBeChecked();
    await expect(page.locator('#replacement-trigger-http401')).not.toBeChecked();
    await page.locator('#replacement-trigger-channel').selectOption('asr');
    await expect(page.locator('#replacement-trigger-http401')).toBeChecked();
    // General save never contains or stores any trigger drafts.
    const beforeGeneral = await read();
    await page.locator('#cfg-temperature').fill('0.42');
    const general = page.waitForResponse((r) => r.url().endsWith('/api/config') && r.request().method() === 'POST');
    await page.locator('#save-cfg-btn').click();
    expect((await general).request().postDataJSON()).not.toHaveProperty('modelReplacement');
    expect((await read()).modelReplacement).toEqual(beforeGeneral.modelReplacement);
    await expect(page.locator('#replacement-trigger-http401')).toBeChecked();
    // Dirty ASR model rows are not saved or discarded by saving its rules.
    await page.locator('[data-replacement-channel="asr"] summary').click();
    await page.locator('#replacement-asr-0').click();
    await page.locator('.model-modal-overlay:not(.closing) #replacement-picker-right [data-replacement-model="2"]').click();
    const beforeRules = await read();
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/model-replacement') && r.request().method() === 'POST');
    await page.locator('#replacement-trigger-save').click();
    const response = await saved; expect(response.ok()).toBeTruthy();
    expect(Object.keys(response.request().postDataJSON()).sort()).toEqual(['channel', 'revision', 'triggers']);
    await expect(page.locator('#replacement-trigger-status')).toContainText('已保存');
    await expect(page.locator('#replacement-asr-0')).toHaveValue(/^C/);
    const afterRules = await read();
    const expected = structuredClone(beforeRules.modelReplacement);
    expected.asr.triggers = { ...defaults, http403: false, http401: true }; expected.asr.revision++;
    expect(afterRules.modelReplacement).toEqual(expected);
    // Own rule save rebases only the known revision, so dirty rows can still save.
    const queueSave = page.waitForResponse((r) => r.url().endsWith('/api/model-replacement') && r.request().method() === 'POST');
    await page.locator('[data-replacement-save="asr"]').click(); expect((await queueSave).ok()).toBeTruthy();
    expect((await read()).modelReplacement.asr.entries[0]).toEqual(entry('C'));
    expect((await read()).modelReplacement.asr.triggers).toEqual(expected.asr.triggers);
    await page.locator('#replacement-trigger-channel').selectOption('chat');
    await expect(page.locator('#replacement-trigger-http402')).not.toBeChecked();
    // A list-only save must not accidentally save or discard dirty rule choices.
    const chatQueueSave = page.waitForResponse((r) => r.url().endsWith('/api/model-replacement') && r.request().method() === 'POST');
    await page.locator('[data-replacement-save="chat"]').click(); expect((await chatQueueSave).ok()).toBeTruthy();
    await expect(page.locator('#replacement-trigger-http402')).not.toBeChecked();
    expect((await read()).modelReplacement.chat.triggers.http402).toBe(true);
    // External edits cause 409; reload only discards selected rule drafts.
    expect((await rules('chat', { ...defaults, http401: true })).ok()).toBeTruthy();
    const stale = page.waitForResponse((r) => r.url().endsWith('/api/model-replacement') && r.request().method() === 'POST');
    await page.locator('#replacement-trigger-save').click(); expect((await stale).status()).toBe(409);
    await expect(page.locator('#replacement-trigger-status')).toContainText('本次未保存');
    await expect(page.locator('#replacement-trigger-http402')).not.toBeChecked();
    await page.locator('#replacement-trigger-reload').click();
    await page.locator('.model-modal-overlay:not(.closing) [data-confirm-accept]').click();
    await expect(page.locator('#replacement-trigger-status')).toContainText('已重新读取');
    await expect(page.locator('#replacement-trigger-http402')).toBeChecked();
    await expect(page.locator('#replacement-trigger-http401')).toBeChecked();
    // Trigger-only drafts also participate in the existing navigation guard.
    await page.locator('#replacement-trigger-http402').uncheck();
    await page.locator('.settings-menu-item[data-section="appearance"]').click();
    await page.locator('.model-modal-overlay:not(.closing) [data-confirm-cancel]').click();
    await expect(page.locator('#replacement-trigger-http402')).not.toBeChecked();
    await page.locator('.settings-menu-item[data-section="appearance"]').click();
    await page.locator('.model-modal-overlay:not(.closing) [data-confirm-accept]').click();
    await page.locator('.settings-menu-item[data-section="api"]').click();
    await expect(page.locator('.model-modal-overlay:not(.closing) [data-confirm-accept]')).toHaveCount(0);
    await expect(page.locator('#replacement-trigger-http402')).toBeChecked();
    await page.locator('#replacement-trigger-editor').screenshot({ path: testInfo.outputPath('triggers-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#replacement-trigger-editor').screenshot({ path: testInfo.outputPath('triggers-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
    expect(errors.filter((e) => !/409 \(Conflict\)/.test(e))).toEqual([]);
  } finally {
    for (const channel of channels) {
      await rules(channel, initial.modelReplacement[channel].triggers);
      await page.request.post('/api/model-replacement', { data: {
        channel, enabled: false, entries: [null, null, null], revision: (await read()).modelReplacement[channel].revision
      } });
    }
    await page.request.post('/api/config', { data: { providers: initial.providers || [], api: { temperature: initial.api.temperature } } });
  }
});
