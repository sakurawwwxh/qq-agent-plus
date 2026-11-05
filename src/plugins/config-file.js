// 插件卸载时的 config.json 清理（CLI 与控制台共用同一口径）。
// 单独成文件是为了守住 src/ops.js 的行数闸门：这段逻辑带解释后接近 40 行，
// 再塞回 CLI 总入口会让 ratchet 失效。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 把插件从 config.json 里摘掉：enabledIds、动作开关，purgeData 时连 settings 一起删。
 * 之前 CLI 只挪目录，重装同 id 会直接继承旧配置与批准（2026-11-05 复核 P2）。
 * 写盘用 tmp+rename，权限保持 0600；配置坏了就跳过，不阻断卸载。
 * @returns {boolean} 是否真的改了 config.json
 */
export function removePluginFromConfig(dataDir, id, { purgeData = false } = {}) {
  const file = path.join(dataDir, 'config.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  const plugins = raw && typeof raw === 'object' && raw.plugins && typeof raw.plugins === 'object'
    ? raw.plugins : null;
  if (!plugins) return false;
  const key = String(id);
  let changed = false;
  if (Array.isArray(plugins.enabledIds)) {
    const next = plugins.enabledIds.filter((value) => String(value) !== key);
    if (next.length !== plugins.enabledIds.length) { plugins.enabledIds = next; changed = true; }
  }
  if (plugins.switches && typeof plugins.switches === 'object'
    && Object.prototype.hasOwnProperty.call(plugins.switches, key)) {
    delete plugins.switches[key];
    changed = true;
  }
  if (purgeData && plugins.settings && typeof plugins.settings === 'object'
    && Object.prototype.hasOwnProperty.call(plugins.settings, key)) {
    delete plugins.settings[key];
    changed = true;
  }
  if (!changed) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能没写出来 */ }
    throw error;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* 非 POSIX 忽略 */ }
  return true;
}
