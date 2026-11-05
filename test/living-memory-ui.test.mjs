import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('living-memory page owns a stable vertical scroll container', () => {
  const css = fs.readFileSync(path.join(ROOT, 'ui', 'style.css'), 'utf8');
  assert.match(css, /#view-living-memory\.view\.active\s*\{[\s\S]*?display:\s*block;[\s\S]*?overflow-y:\s*auto;[\s\S]*?scrollbar-gutter:\s*stable;/);
  assert.match(css, /\.living-memory-page\s*\{\s*width:\s*min\(100%,\s*1200px\)/);
});

test('living-memory page keeps the four-tab console layout', () => {
  const page = fs.readFileSync(path.join(ROOT, 'ui', 'pages', 'living-memory.js'), 'utf8');
  for (const tab of ['overview', 'memories', 'recall', 'settings']) {
    assert.match(page, new RegExp(`\\['${tab}',`));
  }
  assert.match(page, /id="lm-memory-view"/);
  assert.match(page, /data-lm-tab="\$\{key\}"/);
});

test('experiment settings use a dedicated living-memory card', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'ui', 'pages', 'moments.js'), 'utf8');
  assert.match(ui, /id="experiment-living-memory"/);
  assert.match(ui, /id="living-memory-badge"/);
  assert.match(ui, /id="lm-open-console"/);
  assert.match(ui, /id="lm-ungraduate"/);
});

test('living-memory settings expose the recall time budget', () => {
  const page = fs.readFileSync(path.join(ROOT, 'ui', 'pages', 'living-memory.js'), 'utf8');
  assert.match(page, /id="lm-recall-timeout"/);
  assert.match(page, /recallTimeoutMs:\s*Math\.max\(300,\s*Math\.min\(5000,\s*intValue\('#lm-recall-timeout'/);
  assert.match(page, /settingCheck\('lm-auto-capture'/);
  assert.match(page, /id="lm-capture-idle"/);
  assert.match(page, /autoCapture:\s*autoBox\s*\?\s*autoBox\.checked\s*:\s*cfg\.autoCapture\s*!==\s*false/);
});
