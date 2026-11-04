// 备份演练的 SQLite 校验（从 ops.js 抽出，保持 ops 体量闸门）。
// 这里只做只读检查：找不到数据库、缺少 messages.sqlite、打不开或 integrity_check
// 失败都必须算演练失败，不能“跳过”后报成功。
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from './sqlite.js';

export function listSqliteFiles(root, maxDepth = 3) {
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.sqlite')) {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found;
}

/** 返回 { ok, count, message }；调用方负责把 message 打到 stderr。 */
export function verifyBackupDatabases(dataRoot) {
  const databases = listSqliteFiles(dataRoot);
  if (!databases.length) return { ok: false, count: 0, message: '归档里没有任何 SQLite 数据库，不能算恢复演练通过' };
  if (!fs.existsSync(path.join(dataRoot, 'messages.sqlite'))) {
    return { ok: false, count: databases.length, message: '归档缺少 messages.sqlite，不能算恢复演练通过' };
  }
  for (const file of databases) {
    const name = path.relative(dataRoot, file);
    let db = null;
    try {
      db = openDatabase(file, { readOnly: true });
      const row = db.prepare('PRAGMA integrity_check').get();
      const verdict = row ? Object.values(row)[0] : '';
      if (verdict !== 'ok') return { ok: false, count: databases.length, message: `${name}: integrity_check=${verdict || '未知'}` };
    } catch (error) {
      return { ok: false, count: databases.length, message: `${name}: integrity_check 失败（${error?.message || error}）` };
    } finally {
      try { db?.close(); } catch { /* 忽略 */ }
    }
  }
  return { ok: true, count: databases.length, message: '' };
}
