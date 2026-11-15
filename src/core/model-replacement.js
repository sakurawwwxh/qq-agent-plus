import { getConfig, updateConfig } from './config.js';
import { normalizeModelReplacement, MAX_REPLACEMENT_ENTRIES } from './model-replacement-config.js';
import { replacementIdentity, replacementTargetPatch } from './model-replacement-targets.js';
import { isModelReplacementError } from '../llm/model-http-error.js';
import { createLogger } from './logger.js';
const log = createLogger('model-replacement');

// Exposed factory keeps all advancement/concurrency tests independent of disk,
// accounts and paid services. Persistence is synchronous/atomic in updateConfig.
// 先落成 const 再调用：解构参数不在 ops scan 的声明识别范围内（CI 严格门禁）。
export function createModelReplacement(options = {}) {
  const read = options.read || getConfig;
  const write = options.write || updateConfig;
  const now = options.now || Date.now;
  function advance(channel, failed, reason = null) {
    const current = read();
    const before = normalizeModelReplacement(failed.modelReplacement)[channel];
    const chain = normalizeModelReplacement(current.modelReplacement)[channel];
    const sameEntries = JSON.stringify(before.entries) === JSON.stringify(chain.entries);
    const identityChanged = replacementIdentity(current, channel) !== replacementIdentity(failed, channel);
    // Another request already advanced this exact queue, even to its final
    // (disabled) entry: retry its current target, do NOT consume a second entry.
    if (identityChanged) {
      return sameEntries && JSON.stringify(before.triggers) === JSON.stringify(chain.triggers) && chain.nextIndex > before.nextIndex ? current : null;
    }
    if (!chain.enabled || !sameEntries || before.revision !== chain.revision || before.nextIndex !== chain.nextIndex) return null;
    for (let i = chain.nextIndex; i < chain.entries.length; i += 1) {
      const entry = chain.entries[i];
      if (!entry) continue;
      let target;
      try {
        target = replacementTargetPatch(current, channel, entry);
      } catch (error) {
        // 目标模型/凭据可能在链保存后被删除或轮换。跳过这一项继续找后面的有效项；
        // 绝不能把配置错误当成模型错误抛出去，否则会绕过原有兜底模型。
        log.warn(`${channel} 替换目标 ${entry.model} 不可用，跳过：${error?.message ?? error}`);
        continue;
      }
      const candidate = { ...current, ...target };
      const last = !chain.entries.slice(i + 1).some(Boolean);
      const updated = { ...chain, nextIndex: i + 1, enabled: !last,
        revision: chain.revision + 1, lastSwitchAt: now(), lastModel: entry.model };
      const patch = { modelReplacement: { [channel]: updated } };
      for (const [section, value] of Object.entries(target)) patch[section] = { __replace__: value };
      const saved = write(patch);
      log.info(`${channel}${reason ? ` HTTP ${reason.status}` : ''}：切换到 ${entry.model}${last ? '，已到最后一个模型，替换链自动关闭' : ''}`);
      if (replacementIdentity(candidate, channel) !== replacementIdentity(current, channel)) return saved;
      // Duplicate/current selections consume their position without reissuing
      // the very same failed request. All positions remain bounded.
      if (last) return null;
      return advance(channel, saved, reason);
    }
    write({ modelReplacement: { [channel]: { ...chain, enabled: false, revision: chain.revision + 1 } } });
    return null;
  }
  async function run(channel, initial, fn, { signal } = {}) {
    let snapshot = initial;
    for (let i = 0; i <= MAX_REPLACEMENT_ENTRIES; i += 1) {
      signal?.throwIfAborted();
      try { return await fn(snapshot); }
      catch (error) {
        if (signal?.aborted || !isModelReplacementError(error, normalizeModelReplacement(snapshot.modelReplacement)[channel].triggers)) throw error;
        const next = advance(channel, snapshot, error);
        if (!next) throw error;
        snapshot = next;
      }
    }
    throw new Error('模型替换次数超过安全上限');
  }
  return { run, advance };
}
export const withModelReplacement = (...args) => createModelReplacement().run(...args);
