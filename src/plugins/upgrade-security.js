// 插件升级后的安全收口：权限面变化时清空对象级批准/待批，并关闭写动作开关。
// 三个安装入口（索引安装、控制台上传、CLI 文件安装）共用，避免只有索引安装记得做。
import fs from 'node:fs';
import path from 'node:path';
import { resetPluginGrants } from './grants.js';

/**
 * @param {string} dataDir
 * @param {{id: string, upgraded?: boolean, diff?: {permissionChanged?: boolean}}} result installPlugin 的返回值
 * @param {{updateConfig?: Function, log?: Function}} opts 控制台传入 updateConfig 才能落盘开关；
 *   CLI 没有配置单例，只清授权（manifestHash 变化本身也会让旧批准失效）。
 */
export function applyUpgradeSecurity(dataDir, result, { updateConfig = null, log = () => {} } = {}) {
  // 没有 diff（旧清单读不了 + force 覆盖）也必须重置：既然无法证明权限面没变，
  // 就按“变了”处理；否则一个损坏的旧目录会成为跳过清授权的后门。
  if (!result?.upgraded) return null;
  if (result.diff && result.diff.permissionChanged !== true) return null;
  const reset = resetPluginGrants(dataDir, result.id);
  let disabledActions = 0;
  let warning = '';
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugins', result.id, 'plugin.json'), 'utf8'));
    const actions = (Array.isArray(manifest.approvals) ? manifest.approvals : [])
      .map((item) => String(item.action || '')).filter(Boolean);
    if (actions.length && typeof updateConfig === 'function') {
      updateConfig({
        plugins: { switches: { [result.id]: Object.fromEntries(actions.map((action) => [action, false])) } }
      });
      disabledActions = actions.length;
    }
  } catch (error) {
    // 不能静默成功：升级已经换入、授权已清，但旧写开关可能还开着。
    const message = `升级后关闭写开关失败（授权已清空，旧开关可能仍开着）：${error?.message ?? error}`;
    log(`[plugins] ${message}`);
    warning = message;
  }
  return { reset, disabledActions, warning };
}
