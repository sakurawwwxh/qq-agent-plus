import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'ui', 'relationship-pilot.js'), 'utf8');

test('relationship settings snapshot user input before any async refresh', () => {
  const saveStart = source.indexOf('function save(row)');
  const saveEnd = source.indexOf('\n  async function ensureRow()', saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart, 'save(row) should exist');

  const saveBody = source.slice(saveStart, saveEnd);
  const draftAt = saveBody.indexOf('const draft = draftOf(row);');
  const versionAt = saveBody.indexOf('const version = ++saveVersion;');
  const queueAt = saveBody.indexOf('saveQueue = saveQueue.then');

  assert.ok(draftAt >= 0, 'save must capture the form draft');
  assert.ok(versionAt > draftAt, 'draft must be captured before save version advances');
  assert.ok(queueAt > versionAt, 'draft must be captured before async persistence starts');
  assert.doesNotMatch(saveBody, /await\s+readState\s*\(/,
    'save must not refresh the form before capturing the user input');
});

test('定时刷新不覆盖正在编辑的输入框', () => {
  const fillStart = source.indexOf('function fill(row, config, status = null, people = [])');
  const fillEnd = source.indexOf('\n  async function readState', fillStart);
  assert.ok(fillStart >= 0 && fillEnd > fillStart);
  const body = source.slice(fillStart, fillEnd);
  assert.match(body, /row\.contains\(document\.activeElement\)/);
  assert.match(body, /if \(!editing\) input\.value = String\(value\)/);
});

test('relationship persistence reads config without filling stale values first', () => {
  const persistStart = source.indexOf('async function persistDraft(row, draft, version)');
  const persistEnd = source.indexOf('\n  function save(row)', persistStart);
  assert.ok(persistStart >= 0 && persistEnd > persistStart, 'persistDraft should exist');

  const body = source.slice(persistStart, persistEnd);
  const configRead = body.indexOf("const config = await api('/api/config');");
  const post = body.indexOf("await api('/api/config', { method: 'POST'");
  const refresh = body.indexOf('await readState(row);');

  assert.ok(configRead >= 0, 'persistence must read the latest config');
  assert.ok(post > configRead, 'config write must happen after the config read');
  assert.ok(refresh > post, 'UI refresh must only happen after the write succeeds');
  assert.match(body, /\.\.\.draft/,
    'the captured user draft must be the values written to relationshipPilot');
});
