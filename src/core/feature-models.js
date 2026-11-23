// 后台任务模型路由：聊天主模型不动，记忆提炼/群日报/早报/每日动态/空间互动
// 可以各自指向目录里的另一个提供商与模型（通常更便宜或更适合长文写作）。
// 只保存 providerId + model，端点与密钥在运行时从提供商目录解析。
import { createLogger } from './logger.js';
const log = createLogger('feature-models');
const warned = new Set();
export const FEATURE_MODEL_KEYS = Object.freeze([
  'living-memory',
  'memory-consolidation',
  'group-digest',
  'admin-briefing',
  'daily-moments',
  'qzone-interactions'
]);

export const FEATURE_MODEL_LABELS = Object.freeze({
  'living-memory': '长期记忆提炼',
  'memory-consolidation': '旧版记忆整理',
  'group-digest': '群日报',
  'admin-briefing': '管理员早报',
  'daily-moments': '每日动态（说说）',
  'qzone-interactions': '空间互动'
});

const clean = (value) => String(value || '').trim().slice(0, 200);
const usable = (value) => {
  const key = clean(value);
  return key && key !== '******' ? key : '';
};
function providerOf(cfg, providerId) {
  return (cfg?.providers || []).find((item) => item?.id === providerId) || null;
}
function providerKey(cfg, provider) {
  // 与 resolveApiKey 同口径：只认这家 provider 自己的 Key。绝不回退顶层 api.apiKey
  //（手动模式的遗留 Key 可能属于另一家，跟着 provider id 发出去就是跨厂商泄露）。
  return usable(cfg?.providerKeys?.[provider?.id]) || usable(provider?.apiKey);
}

export function normalizeFeatureModels(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(FEATURE_MODEL_KEYS.map((key) => {
    const value = input[key] && typeof input[key] === 'object' && !Array.isArray(input[key]) ? input[key] : {};
    return [key, {
      enabled: value.enabled === true,
      providerId: clean(value.providerId),
      model: clean(value.model)
    }];
  }));
}

/** 单条功能路由的可用性（不联网）：UI 与运行期共用同一口径。 */
export function featureModelStatus(cfg, feature) {
  if (!FEATURE_MODEL_KEYS.includes(feature)) return { enabled: false, ready: false, reason: '未知的后台任务' };
  const entry = normalizeFeatureModels(cfg?.featureModels)[feature];
  if (!entry.enabled) return { ...entry, ready: false, reason: '未启用，跟随主模型' };
  const provider = providerOf(cfg, entry.providerId);
  if (!provider) return { ...entry, ready: false, reason: '提供商已从模型目录删除' };
  if (!clean(provider.baseURL)) return { ...entry, ready: false, reason: '提供商缺少 Base URL' };
  if (!entry.model) return { ...entry, ready: false, reason: '未填写模型 id' };
  if (!providerKey(cfg, provider)) return { ...entry, ready: false, reason: '提供商未保存密钥' };
  const models = (provider.models || []).map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean);
  return {
    ...entry, ready: true, reason: '', baseUrl: clean(provider.baseURL),
    // 目录里已经没有这个模型时仍按原 id 调用（可能是目录未刷新），但控制台要提示。
    catalogMissing: models.length > 0 && !models.includes(entry.model)
  };
}

/** 解析成 chatCompletion 的 overrides；未就绪返回 null。 */
export function featureModelOverrides(cfg, feature) {
  const status = featureModelStatus(cfg, feature);
  if (!status.ready) {
    // 启用了但配置失效：运行时只能退回主模型。日志每个原因提示一次，避免静默多花钱。
    if (status.enabled === true) {
      const key = `${feature}:${status.reason || 'unknown'}`;
      if (!warned.has(key)) {
        warned.add(key);
        log.warn(`后台任务「${FEATURE_MODEL_LABELS[feature] || feature}」配置不可用（${status.reason}），本次改用主模型`);
      }
    }
    return null;
  }
  const provider = providerOf(cfg, status.providerId);
  const apiKey = providerKey(cfg, provider);
  return {
    baseUrl: status.baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: status.model,
    provider: status.providerId,
    // 后台任务走独立模型时不继承主渠道的额外请求参数（可能含另一家的鉴权头）。
    extraBody: {},
    thinkingParams: {}
  };
}

