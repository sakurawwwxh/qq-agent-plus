// 省 Token 模式：只给几个"可控项"夹上限，**不改写**用户已经填好的值 —— 关掉立刻回到原设置。
//
// 为什么是这几个项（2026-09-23 用线上真实用量算过一遍）：
//   · 每次模型调用的固定底（系统提示 + 工具定义）约 1.2 万~1.5 万 token，靠设置改不动它；
//   · 剩下能动的就是：上下文档位各档读多少条已读、单次运行的工具轮数与累计 token、
//     会话交接与全局印象注入的字符上限、系统提示里的表情清单条数。
//   线上 7 天数据（867 次调用 / 1836 万 token）：输入占 98.8%，其中"没命中缓存的输入"占花费的 76%。
//   按这里的上限压，每次唤醒的输入大约降三到五成（档位条数是大头，交接/记忆/清单是小头）。
//
// 用法：`cappedByTokenSaver(用户设置值, caps.xxx)` —— caps 为空（模式关闭）时原样返回。
export const TOKEN_SAVER_MODES = ['off', 'balanced', 'aggressive'];
export const TOKEN_SAVER_LABELS = { off: '关闭', balanced: '省', aggressive: '很省' };

const CAPS = {
  off: null,
  balanced: {
    atCount: 80, keywordCount: 50, randomCount: 30, allCount: 80,
    maxRounds: 8, maxRunTokens: 80000,
    handoffMaxChars: 2000, memoryBlockChars: 3000, promptMaxStickers: 5
  },
  aggressive: {
    atCount: 40, keywordCount: 30, randomCount: 20, allCount: 40,
    maxRounds: 5, maxRunTokens: 50000,
    handoffMaxChars: 1200, memoryBlockChars: 1500, promptMaxStickers: 3
  }
};

export function normalizeTokenSaverMode(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return TOKEN_SAVER_MODES.includes(value) ? value : 'off';
}

/** 该模式的上限表；关闭模式返回 null（= 什么都不夹）。 */
export function tokenSaverCaps(mode) {
  return CAPS[normalizeTokenSaverMode(mode)] || null;
}

/** 三档的上限表（控制台渲染用，避免界面里再抄一份数字）。 */
export function tokenSaverCapTable() {
  return { off: null, balanced: CAPS.balanced, aggressive: CAPS.aggressive };
}

export function tokenSaverCapsOf(cfg) {
  return tokenSaverCaps(cfg?.tokenSaver?.mode);
}

/**
 * min(用户设置值, 上限)。
 * · 上限为空（模式关闭）时只做"取非负数"的归一：`Math.max(0, Number(value) || 0)` ——
 *   与各调用点原来的 `Number(x) || 0` 写法一致，所以 `off` 与升级前逐字同行为。
 * · 上限存在时再夹一层，且只往下夹（不会把用户的小值抬上去）。
 * · `0` 是合法值（例如"不读历史"），不会被抬成 1。
 */
export function cappedByTokenSaver(value, cap) {
  const n = Math.max(0, Number(value) || 0);
  if (cap === null || cap === undefined) return n;
  const limit = Math.max(1, Number(cap) || 1);
  return Math.min(n, limit);
}

/**
 * 单次运行的两个生效上限（工具轮数 / 累计 Token）：min(用户设置, 省 Token 上限)。
 * 关闭模式时与升级前的表达式逐字等价（12 轮 / 16 万 token 兜底），便于单测与复用。
 */
export function effectiveRunLimits(cfg = {}) {
  const caps = tokenSaverCapsOf(cfg);
  return {
    maxRounds: Math.max(1, cappedByTokenSaver(Number(cfg?.api?.maxRounds) || 12, caps?.maxRounds)),
    maxRunTokens: Math.min(
      1000000,
      Math.max(20000, cappedByTokenSaver(Number(cfg?.api?.maxRunTokens) || 160000, caps?.maxRunTokens))
    )
  };
}

/**
 * 给控制台用：把当前模式与每一项的"用户值 / 生效值 / 是否被夹住"列出来。
 * 纯函数，不读盘；调用方传入当前配置即可。
 */
export function tokenSaverEffective(cfg = {}) {
  const mode = normalizeTokenSaverMode(cfg.tokenSaver?.mode);
  const caps = tokenSaverCaps(mode);
  // 每行按"运行时的真实读法"取用户值，界面才不会和实际行为对不上：
  //   条数四项运行时是 `Math.max(0, Number(v) || 0)` —— 0 合法（不读历史）；
  //   其余几项运行时是 `Number(v) || 默认值` —— 填 0/空等于用默认。
  const count = (value) => Math.max(0, Number(value) || 0);
  const num = (value, fallback) => Number(value) || fallback;
  const rows = [
    { key: 'atCount', label: '被艾特时读多少条已读', user: count(cfg.store?.atCount), cap: caps?.atCount },
    { key: 'keywordCount', label: '关键词命中时读多少条', user: count(cfg.store?.keywordCount), cap: caps?.keywordCount },
    { key: 'randomCount', label: '随机响应时读多少条', user: count(cfg.store?.randomCount), cap: caps?.randomCount },
    { key: 'allCount', label: '全部响应时读多少条', user: count(cfg.store?.allCount), cap: caps?.allCount },
    { key: 'maxRounds', label: '单次运行最大工具轮数', user: num(cfg.api?.maxRounds, 12), cap: caps?.maxRounds },
    { key: 'maxRunTokens', label: '单次运行累计 Token 上限', user: num(cfg.api?.maxRunTokens, 160000), cap: caps?.maxRunTokens },
    { key: 'handoffMaxChars', label: '会话交接注入上限（字符，配置文件里改）', user: num(cfg.memory?.handoffMaxChars, 4000), cap: caps?.handoffMaxChars },
    { key: 'memoryBlockChars', label: '全局印象注入上限（字符，固定值）', user: 6000, cap: caps?.memoryBlockChars },
    // 表情清单的运行时读法是"非正数/坏值按默认 10"（prompt.js 里 `want > 0 ? want : 10`），
    // 所以手改成 -5 时这一行要说 10 —— 说 -5 或 0 都是运行时不会发生的事。
    { key: 'promptMaxStickers', label: '提示词里的表情清单条数', user: (Number(cfg.sticker?.promptMaxStickers) > 0 ? Number(cfg.sticker.promptMaxStickers) : 10), cap: caps?.promptMaxStickers },
    // 日说说有**自己的**轮次旋钮（dailyMoments.maxRounds，默认 8），与聊天那条 api.maxRounds 不是一回事
    { key: 'dailyMomentsMaxRounds', label: '每日动态最大轮次（配置文件里改）', user: num(cfg.dailyMoments?.maxRounds, 8), cap: caps?.maxRounds }
  ];
  // 这几项除了"被省 Token 夹上限"，运行时还有自带的上下限（升级前就有的老兜底）：
  // maxRunTokens 20000..1000000（effectiveRunLimits）、handoffMaxChars 500..12000（formatHandoffForPrompt）、
  // dailyMomentsMaxRounds 2..16（normalizeDailyMoments）、maxRounds 至少 1、
  // promptMaxStickers 1..60（buildStickerContext 里 `Math.min(60, …)`）。
  // 对照表按运行时的真实读法算，否则会报出一个根本不生效的数字
  // （例如手改 maxRunTokens=5000，实际仍会花到 20000，界面不能显示 5000）。
  const bounds = {
    maxRounds: [1, null], maxRunTokens: [20000, 1000000],
    handoffMaxChars: [500, 12000], dailyMomentsMaxRounds: [2, 16],
    promptMaxStickers: [1, 60]
  };
  return {
    mode,
    label: TOKEN_SAVER_LABELS[mode] || TOKEN_SAVER_LABELS.off,
    active: mode !== 'off',
    capsByMode: tokenSaverCapTable(),
    rows: rows.map((row) => {
      const [floor, ceiling] = bounds[row.key] || [0, null];
      return {
        ...row,
        effective: Math.min(ceiling ?? Infinity, Math.max(floor, cappedByTokenSaver(row.user, row.cap))),
        clamped: row.cap !== null && row.cap !== undefined && row.user > row.cap
      };
    })
  };
}
