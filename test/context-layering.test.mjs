// Issue #86 第 2 阶段：默认只带最近 24 条 / 8000 字历史；关闭分层时恢复旧口径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-context-layering-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { ChatStore } = await import('../src/core/store.js');
const { buildPastState } = await import('../src/llm/prompt.js');

test('分层上下文默认把历史压到 24 条 / 8000 字；关闭后恢复旧口径', (t) => {
  const store = new ChatStore(0, { dataDir: root, filename: 'messages.sqlite' });
  t.after(() => store.close());
  const chatKey = 'group:1';
  for (let i = 0; i < 80; i += 1) {
    store.appendIncoming(chatKey, {
      mid: 1000 + i, ts: Date.now() - i * 1000, senderId: '42', senderName: 'A',
      text: `${i}-${'x'.repeat(300)}`, media: []
    });
  }
  store.drainUnread(chatKey);

  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.store = {
    ...cfg.store,
    allCount: 80,
    pastStateMaxChars: 100000,
    contextLayering: { enabled: true, maxHistoryMessages: 24, maxHistoryChars: 8000 }
  };
  setRuntimeConfig(cfg);
  const layered = buildPastState(store, chatKey);
  assert.ok(layered.count <= 24, `条数应被分层上限夹住，实际 ${layered.count}`);
  assert.ok(layered.text.length <= 8000, `字符应被分层上限夹住，实际 ${layered.text.length}`);

  cfg.store.contextLayering = { enabled: false, maxHistoryMessages: 24, maxHistoryChars: 8000 };
  setRuntimeConfig(cfg);
  const full = buildPastState(store, chatKey);
  assert.ok(full.count > 24, `关闭分层时应恢复更多历史，实际 ${full.count}`);
  assert.ok(full.text.length > 8000, `关闭分层时应恢复更高字符上限，实际 ${full.text.length}`);
});
