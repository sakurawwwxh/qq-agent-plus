// 会话留档的文件名口径与读写（不带任何配置/目录副作用）。
//
// 单独成模块的原因：用量聚合、价格缺口（ops）、健康检查都要按同一口径枚举留档，
// 但它们指向的数据目录可能不同（ops 支持 --data-dir），也不该为了一个文件名正则
// 去 import config.js。会话文件有两种形态：<id>.json 与压缩归档 <id>.json.gz。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// id 本身不含点，所以两个分支不会歧义。
const SESSION_FILE_RE = /^(.+)\.json(\.gz)?$/;

/** 是否是会话留档文件名（含压缩归档）。 */
export function isSessionFileName(name) {
  return SESSION_FILE_RE.test(String(name || ''));
}

/** 从文件名取出会话 id（`.json` / `.json.gz` 都适用）。 */
export function sessionIdOfFile(name) {
  const m = SESSION_FILE_RE.exec(String(name || ''));
  return m ? m[1] : '';
}

/**
 * 列出留档文件（未压缩 + 压缩）。同一个 id 两种形态可能短暂并存（压缩收尾崩溃的残留），
 * 调用方按 id 去重时**优先未压缩**那份。
 */
export function listSessionFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    // "目录不存在"与"读不了"必须区分：调用方常把空数组当成"文件全没了"，
    // 于是 EACCES/EBUSY/EMFILE 会被误判成大规模删除（进而清空索引）。
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const name of names) {
    if (!isSessionFileName(name)) continue;
    out.push({ id: sessionIdOfFile(name), file: path.join(dir, name), compressed: name.endsWith('.gz') });
  }
  return out;
}

/** 读一份留档（自动识别 .gz）；坏文件/不存在返回 null。 */
export function readSessionFile(file) {
  try {
    const buf = fs.readFileSync(file);
    const raw = String(file).endsWith('.gz') ? zlib.gunzipSync(buf) : buf;
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}
