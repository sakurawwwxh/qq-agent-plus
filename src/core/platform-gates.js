// 平台能力门控（控制台「平台能力」页，2026-10-07 协议端能力全量接入）：
// 「开关键 → 工具名」映射、默认开关取向、按群覆盖、配额上限，全部只在这一个文件里定义。
//
// 为什么独立成 core 模块：orchestrator（按会话过滤工具表）、prompt（教不教用法）、
// 控制台（渲染与保存）三处都要用同一份 —— 以前这张表长在 tools-core 里，
// prompt.js 要用就得 import tools/，而 tools-core 又 import llm/*，容易绕成环。
// 本模块**零依赖**（不 import 任何东西），谁都能引。tools-core 再导出一次，
// 既有 `from '../tools/tools-core.js'` 的引用路径不变。
//
// 键的拆分口径（2026-10-07 用户要求"控制台设置详细一点"）：
//   读与写分开 —— "只让它看，不让它动手"要能单独配出来；
//   默认关（PLATFORM_DEFAULT_OFF）：换头像、改昵称/个性说明、传相册，以及新增的私聊文本文件。
// 默认值组合起来与拆分前**逐项等价**（例如 avatarWrites 关 = 头像与昵称都不放行）。

/** 门控键 → 该键管的工具名（一个工具只归属一个键，顺序即控制台渲染顺序）。 */
export const PLATFORM_TOOL_GATES = {
  // ── 读 / 收 ──
  reactions: ['get_message_reactions'],
  albumRead: ['list_group_album'],
  groupFiles: ['list_group_files', 'group_file_url'],
  groupTools: ['get_group_profile'],
  ocr: ['read_image_text'],
  // ── 写 / 发 ──
  reactionsWrite: ['react_to_message'],
  faceWrites: ['send_face'],
  qqVoice: ['send_qq_voice'],
  profileWrites: ['set_my_signature', 'set_my_status'],
  remarkWrites: ['set_remark'],
  avatarWrites: ['set_my_avatar'],
  nicknameWrites: ['set_my_profile'],
  groupWrites: ['group_sign', 'set_group_todo'],
  groupFileSend: ['send_group_file'],
  privateFileSend: ['send_private_file'],
  albumWrites: ['like_album_photo', 'comment_album_photo'],
  albumUpload: ['upload_to_group_album']
};

/** 控制台用的短标签（纯展示；接口把它和工具名一起下发，避免 UI 再维护一份表）。 */
export const PLATFORM_GATE_LABELS = {
  reactions: '看表情回应',
  reactionsWrite: '贴表情回应',
  faceWrites: '发 QQ 系统表情（小黄脸）',
  qqVoice: 'QQ 原生语音',
  profileWrites: '改个性签名 / 在线状态',
  remarkWrites: '改好友/群备注',
  avatarWrites: '换 QQ 头像',
  nicknameWrites: '改 QQ 昵称 / 个性说明',
  groupTools: '看群资料 / 公告 / 荣誉',
  groupWrites: '群签到 / 设群待办',
  ocr: '服务端 OCR（读图上的字）',
  groupFiles: '群文件：看目录 / 取直链',
  groupFileSend: '群文件：发文件到群',
  privateFileSend: '私聊文件：发送纯文本资料',
  albumRead: '相册：看相册与照片',
  albumWrites: '相册：点赞 / 评论',
  albumUpload: '相册：把图传进相册'
};

/**
 * "默认关"的键：未显式 true 就不放行。
 * 账号外观/相册三项和新增的私聊文本文件须主动启用；其余键显式 false 才关。
 */
export const PLATFORM_DEFAULT_OFF = new Set(['avatarWrites', 'nicknameWrites', 'albumUpload', 'privateFileSend']);

/** 全部门控键（控制台按群覆盖编辑器、迁移校验都用它）。 */
export const PLATFORM_GATE_KEYS = Object.freeze(Object.keys(PLATFORM_TOOL_GATES));

export const PRIVATE_FILE_DEFAULT_MAX_KIB = 64;
export const PRIVATE_FILE_HARD_MAX_KIB = 256;

/** 正文按 UTF-8 字节计；零和非法值不是不限量，手改配置也不能突破硬上限。 */
export function privateFileMaxKiB(platform = {}) {
  const n = platform?.privateFileMaxKiB;
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.max(1, Math.min(PRIVATE_FILE_HARD_MAX_KIB, Math.floor(n))) : PRIVATE_FILE_DEFAULT_MAX_KIB;
}

/**
 * 从 chatKey（`group:123`）或裸群号（`123`）解析出群号；私聊/其它形态返回 ''（无按群覆盖）。
 * 裸数字也当群号：控制台那边手里只有 group_id（事件与配置里都是裸号）。
 */
export function platformGroupIdOf(chatKey = '') {
  const s = String(chatKey ?? '').trim();
  if (!s) return '';
  if (s.startsWith('group:')) return s.slice(6);
  if (s.startsWith('private:')) return '';
  return /^\d+$/.test(s) ? s : '';
}

/** 取某个群的覆盖对象（只认显式布尔值；坏形状当没有）。 */
function overridesFor(platform, groupId) {
  if (!groupId) return null;
  const map = platform?.perGroup;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const node = map[groupId];
  return node && typeof node === 'object' && !Array.isArray(node) ? node : null;
}

/**
 * 某个非工具类平台开关的生效值（读/写都走这里）：
 * 按群覆盖（platform.perGroup[gid][key]）优先于全局值，但只在它**是布尔值**时生效
 * （字符串 'true'、缺键都按未设置处理，回落全局）。
 */
export function platformGateAllowed(key, platform = {}, chatKeyOrGroup = '') {
  const over = overridesFor(platform, platformGroupIdOf(chatKeyOrGroup));
  const raw = over && typeof over[key] === 'boolean' ? over[key] : platform?.[key];
  return PLATFORM_DEFAULT_OFF.has(key) ? raw === true : raw !== false;
}

/** 某个工具在（可选的）会话上下文里是否可用；不属于任何门控键的工具一律放行。 */
export function platformToolAllowed(name, platform = {}, chatKeyOrGroup = '') {
  const tool = String(name || '');
  if (tool === 'send_private_file' && !/^private:[1-9]\d*$/.test(String(chatKeyOrGroup))) return false;
  for (const [key, tools] of Object.entries(PLATFORM_TOOL_GATES)) {
    if (!tools.includes(tool)) continue;
    return platformGateAllowed(key, platform, chatKeyOrGroup);
  }
  return true;
}

// ── 平台写入类动作的每日/每小时闸门（tools-core 的四个 createQuota 用这组上限） ──
// 语义：0/非法值 = 用默认（**不是**"不设限"——这是防模型抽风的刹车，不该被一个 0 悄悄拆掉）；
// 上限硬顶 200，防手滑把刹车调到没意义。
export const PLATFORM_QUOTA_DEFAULTS = Object.freeze({
  // 2026-10-07 两次收紧（用户："不用这么频繁吧？""你按真人的标准来呀"）：
  // 这些是**刹车**不是目标，标准是"真人会怎么做"，不是"技术上别刷爆"。
  // 真人在群里贴表情是高频轻互动，但改签名/备注/头像是低频大动作。
  reactionsPerHour: 10,   // 贴表情：每小时（平均 6 分钟一个；热闹时段真人也差不多）
  profilePerDay: 1,       // 签名 / 在线状态（一天改一次都算勤）
  remarksPerDay: 1,       // 备注（认识新人时打一次标签，不是日常动作）
  avatarsPerWeek: 1,      // 换头像：**窗口是 7 天**（真人按周/月换；"每天 1 次"一周也能换 7 次）
  albumWritesPerHour: 5,  // 相册点赞/评论：每小时（评论所有人都看得到，比贴表情更容易变成噪音）
  privateFilesPerDay: 10  // 私聊文本文件：每天（防模型把聊天变成文件下载器）
});

export const PLATFORM_QUOTA_KEYS = Object.freeze(Object.keys(PLATFORM_QUOTA_DEFAULTS));

/** 某个配额键的生效上限（读 config.platform.quotas）。 */
export function platformQuotaLimit(config, key) {
  const fallback = PLATFORM_QUOTA_DEFAULTS[key];
  if (!fallback) return Infinity;
  const n = Number(config?.platform?.quotas?.[key]);
  // 下界必须夹到 1：`0 < n < 1`（手改 config 或直连 API 能写进 0.5）floor 会得到 0，
  // 而 core/quota.js 的 normMax 把 ≤0 当"不设限" —— 闸门会被静默解除（2026-10-07 审计）。
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(200, Math.floor(n))) : fallback;
}
