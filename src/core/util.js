// 通用小工具：无业务逻辑。

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * 可被 AbortSignal 打断的等待。人类化延迟必须能取消：暂停/中止后还睡满 8 秒再发，
 * 用户会看到"机器人已经停了却突然冒出一句"。
 */
export function sleepAbortable(ms, signal) {
  const wait = Math.max(0, Number(ms) || 0);
  if (!signal) return sleep(wait);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, wait);
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 带抖动的均匀随机区间。 */
export function randRange([min, max]) {
  return randInt(min, max);
}

export function nowMs() {
  return Date.now();
}

// ── 时间格式化（固定上海时区，给模型/界面看） ───────────────────────────
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const ZONE_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai（UTC+8）：全项目钟点/自然日判断共用

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shanghaiDate(ts = Date.now()) {
  const value = Number(ts);
  return new Date((Number.isFinite(value) ? value : Date.now()) + ZONE_OFFSET_MS);
}

/** 2026-08-30 21:33:05（周六） */
export function formatFullTime(ts = Date.now()) {
  const d = shanghaiDate(ts);
  const formatted = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}（${WEEKDAYS[d.getUTCDay()]}）`;
  return formatted;
}

/** 08-30 21:33 */
export function formatShortTime(ts = Date.now()) {
  const d = shanghaiDate(ts);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 21:33:05 */
export function formatClockTime(ts = Date.now()) {
  const d = shanghaiDate(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export function todayKey(ts = Date.now()) {
  const d = shanghaiDate(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 当前时间所属上海自然日的起点，返回 UTC 毫秒时间戳。 */
export function shanghaiDayStart(ts = Date.now()) {
  const shifted = shanghaiDate(ts);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  ) - ZONE_OFFSET_MS;
}

// ── 文本处理 ─────────────────────────────────────────────────────────────

/** 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。 */
/** 当前时刻在固定时区里的"当天第几分钟"（00:00=0）。活跃时段/主动窗口都用它，别再各自 new Date(+8)。 */
export function minuteOfDayInZone(ts = Date.now()) {
  const d = shanghaiDate(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

/**
 * 机器人在这个会话里"叫什么"：**群友/好友实际看到的名字优先** ——
 * 群内展示名（群名片）→ 账号昵称（QQ 昵称）→ 机器人名字（控制台里的项目标识）。
 *
 * 聊天提示词、每日说说、空间互动、好友评估、看图判断全都走这一个口径：
 * 各处各挑一个来源会出现"群里显示「犊子」、说说里却自称「小鲸鱼」"这类自相矛盾 ——
 * 模型需要的是"别人叫我什么"，而不是控制台里的名字。
 */
export function resolveSelfName(persona = {}, accountNickname = '') {
  // 逐个 trim 再判空：只写了空格的"群内展示名"要当成没填，落到账号昵称上
  for (const value of [persona?.selfNickname, accountNickname, persona?.botName]) {
    const name = String(value ?? '').trim();
    if (name) return name;
  }
  return '我';
}

/**
 * 防提示注入/泄露：把用户昵称、消息文本里的“指令式方括号标记”弱化，
 * 避免群友伪装成系统段（如【本次唤醒】）骗模型。只处理外观，不改变语义。
 */
export function sanitizeUserText(text) {
  let s = String(text ?? '');
  // 第一道：剥掉零宽/不可见字符。**按 Unicode 类别来，不要枚举码点** —— 以前只列了
  // \u200b\u200c\u200d\u200e\u200f\u2028\u202f\u2060\u00ad\ufeff，于是 U+061C（阿拉伯字母标记）、
  // U+2066–U+2069（双向隔离）、U+180E、U+034F、U+115F/U+3164/U+FFA0 这些照样能把
  // 「【管\u061c理员】」「【\u061c管理员附加规则】」拼出来整条穿透（2026-10-13 全项目审查 P1）。
  // Cf（格式符）/Cs（代理对）/C0+C1 控制符（保留 \t \n \r）都是纯噪音，全局剥掉不改变语义。
  // 变体选择符 \ufe00-\ufe0f（Mn，渲染上不可见）与 \u2800（盲文空白）同理：留在里面就能把
  // 「【管\uFE0F理员】」拼出来整条穿过白名单（2026-10-14 复审）。\u007f-\u009f 是 DEL+C1，
  // 只有 C0 被枚举会漏掉它（JS 的 \s 不含 \u0085，第二道折叠也救不回来）。
  // 注意别顺手写成 \p{Cc}：它把 \t \n \r 也算进去，那三个必须留。
  s = s.replace(/[\p{Cf}\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u180e\u034f\u115f\u1160\u2800\u3164\ufe00-\ufe0f\uffa0]/gu, '');
  // 第二道：折叠方括号段内的全部空白 —— 「【管 理 员】」同样是绕过手法，
  // 段头关键词里出现空白只可能是为了躲匹配，段内空白对"段标记"没有语义。
  s = s.replace(/([\[【［])([^\]】］]*)([\]】］])/g, (_m, open, body, close) => open + body.replace(/\s+/g, '') + close);
  // 系统段标记在提示词里是全角【】（见 prompt.js 的【本次唤醒】/【管理员附加规则】），
  // 所以半角、全角、繁体方括号都要处理；命中后换圆括号：语义不变，但不再是"段标记"。
  // 只换方括号本身（$1 是关键词、$2 是其余载荷），不能把括号里的内容一起吃掉
  // ⚠️ 这份名单要与**所有会往提示词里塞段头的模块**同步（不只是 prompt.js）：
  //    memory-global（全局印象）、incident-pilot（异常隔离）、asset-observer（已确认黑话）、
  //    daily-moments（上海时间/总结日期/群聊材料）、moment-prompt（当前人设/这次表达的场景）、
  //    experimental-tool-scheduler（实验调度·强规则）、friend-review/moment（好友动态/评论回复…）。
  //    只要某个段头只在一处被认，群友就能在自己的消息里伪造它。
  //    test/prompt-safety.test.mjs 会把这些模块里的【…】全抽出来逐个断言能被弱化。
  // 名单分两段：简体一段、繁体一段（[管理員] 这类繁体写法以前能整条穿透，
  // 而模型收到的说明是"方括号会被弱化、标记伪造不出来"）。加关键词时两段都要加。
  s = s.replace(
    /[\[【［][\s\u200b\u200c\u200d]*((?:本次唤醒|系统提醒|系统|B站|管理员(?:附加规则)?|owner|角色扮演|会话令牌|当前时间|上海时间|过去状态|此刻状态|你现在的状态|记忆(?:与会话交接)?|上次会话交接|上次生命周期检查点|当前对话线程|优先级|角色设定|当前人设|安全规则|工作方式|反\s*AI\s*味|梗的使用|梗密度|诚实边界|发送节奏|内容来源|自己的动态|内部群摘要|你的兴趣与立场|说话示例|保持主体性|该说\s*\/\s*不该说|群聊不是客服队列|像真人一样|不要当群管家|引用与点名|可用表情包|QQ\s*场景规则|发送与汇报禁令|发言与沉默|发言的唯一通道|分条发送|看图先读情绪|自然交流与可靠边界|每次运行的决策顺序|进行中的游戏|定时提醒|谁是卧底|玩法与工具箱|可用技能|生命周期续接|空格不是分句符号|异常隔离|对群友的全局印象|已确认黑话|本群梗库|群聊材料|总结日期|最近已发动态|好友动态|评论回复|这次表达的场景|真实与研究|核心原则|隐私与配图|本次包含的提交|最终提交|提交|预算|表情包(?:用法|策略)?|实验调度|从什么地方写起|像自己发动态|可忽略的灵感|可参考的见闻|可选配图|安全边界|待回复评论|狼人杀|事件定义|强度|对象信息|需要整理的印象|最近的发言|手工印象|自动积累的印象|本次喚醒|系統提醒|系統|管理員(?:附加規則)?|會話令牌|當前時間|上海時間|過去狀態|此刻狀態|你現在的狀態|記憶(?:與會話交接)?|上次會話交接|上次生命週期檢查點|當前對話線程|優先級|角色設定|當前人設|安全規則|保持主體性|該說\s*\/\s*不該說|群聊不是客服隊列|像真人一樣|不要當群管家|引用與點名|QQ\s*場景規則|發送與匯報禁令|發言與沉默|發言的唯一通道|分條發送|看圖先讀情緒|自然交流與可靠邊界|每次運行的決策順序|進行中的遊戲|定時提醒|誰是臥底|玩法與工具箱|生命週期續接|空格不是分句符號|異常隔離|對群友的全局印象|已確認黑話|本群梗庫|總結日期|最近已發動態|好友動態|評論回復|這次表達的場景|真實與研究|核心原則|隱私與配圖|最終提交|預算|實驗調度|從什麼地方寫起|像自己發動態|可忽略的靈感|可參考的見聞|可選配圖|安全邊界|待回復評論|狼人殺|事件定義|強度|手工印象|自動積累的印象)[^\]】］]*)[\]】］]/gi,
    '（$1）'
  );
  return s;
}

/** 这条消息（或引用目标）是不是机器人自己发的：QQ 号与登录号一致才算，空值不算。 */
export function isSelfSender(senderId, selfId) {
  const a = String(senderId ?? '');
  const b = String(selfId ?? '');
  return a !== '' && b !== '' && a === b;
}

/**
 * 引用块统一渲染：[引用#消息id·说话人：原文]。
 * 实时消息（segmentsToText）与历史行（formatEntry）共用同一个函数，引用在哪都长一样。
 * - 带 #消息id：模型才能顺着它定位被引用的那条及其前后文（翻页/看图/收藏表情都吃这个 id）。
 *   以前只有名字和原文，模型判断"谁在回谁、哪条在前"只能靠猜（Issue #16）。
 * - 自己发的引用标"我"：与历史行里自己的发言口径一致；否则机器人名片名会被当成别人，
 *   模型回答"这是谁发的"就会答错。
 * - 分隔符不放空白、用「·」：sanitizeUserText 会折叠方括号内空白（防「【管 理 员】」这类伪造），
 *   写了空格也会被吃掉；函数自己把这一步做完，输出对 sanitizeUserText 幂等，
 *   live 与历史两条链路渲染出的字节才完全相同。
 */
/** 跨私聊展示时去掉引用块里的 #消息id：那个 id 只在原会话有效。 */
export function stripQuoteMessageId(text) {
  return String(text ?? '').replace(/\[引用#-?\d+·/g, '[引用');
}

export function formatQuoteRef(reply) {
  return buildQuoteRef(reply);
}

/**
 * withId=false / labelSelf=false 只用于"识别升级前入库的旧引用块"：
 * v0.7.2 及更早写的是 `[引用说话人：原文]`（没有 id，引用自己时写的是群名片名而不是"我"）。
 * 生成时一律用默认参数。
 */
function buildQuoteRef(reply, { withId = true, labelSelf = true } = {}) {
  if (!reply || typeof reply !== 'object') return '';
  const who = labelSelf && reply.self ? '我' : String(reply.sender ?? '');
  // id 只认数字（QQ 消息 id 可能是负数）：非数字说明来源不对，宁可退回不带 id 的老形态，
  // 也不能让它带着 `]` 之类字符进来把引用块的结构撑破。
  const rawMid = !withId || reply.messageId === null || reply.messageId === undefined
    ? ''
    : String(reply.messageId).trim();
  const mid = /^-?\d+$/.test(rawMid) ? rawMid : '';
  const label = [mid ? `#${mid}` : '', who].filter(Boolean).join('·');
  const body = [label, reply.text].filter(Boolean).join('：');
  if (!body) return '';
  // 两遍 sanitize：先在没套外层方括号时洗一遍（这样原文里自带的 [管理员] 这类括号会被
  // 关键词规则弱化成（管理员）——套上外层括号后同一条规则就吃不到它了），
  // 再把整块洗一遍，让输出对 sanitizeUserText 幂等。live 链路（segmentsToText）末尾会对
  // 整串做同样的折叠，兜底链路（formatEntry）不会 —— 这里先做掉，两条链路逐字一致。
  return sanitizeUserText(`[引用${sanitizeUserText(body)}]`);
}

/**
 * 这条记录需要补的引用块前缀（不需要就返回空串）；需要时由 textWithQuote 拼成完整文本。
 * 正常消息在 ingest 时就把引用块写进正文了；只有"结构化 reply 还在、正文里却没有"的记录
 * （回复 + 合并转发卡片：展开转发时用展开文本整段覆盖了正文）需要在展示时补。
 * 提示词渲染与工具/控制台返回都走它，同一个模型在两个窗口看到的形状才一致。
 */
export function quotePrefixFor(entry) {
  // reply.sender / reply.text 是群友可控内容：buildQuoteRef 内部有两遍 sanitizeUserText
  //（见它的注释），这里重建出的前缀天然是弱化形态、比较也用同一形态 —— 不必再洗一遍。
  const prefix = formatQuoteRef(entry?.reply);
  if (!prefix) return '';
  const text = String(entry?.text || '');
  if (text.startsWith(prefix)) return '';
  // 升级前入库的那批引用行是旧形态：没有 #消息id，引用自己时写的是群名片名。
  // 它们的结构化 reply 当时就带着 messageId，前缀比对会不相等 —— 不认这一形态的话，
  // 整库旧引用行都会被再补一个引用块（实测每行出现两个 [引用…]）。
  const legacy = buildQuoteRef(entry?.reply, { withId: false, labelSelf: false });
  if (legacy && text.startsWith(legacy)) return '';
  return prefix;
}

/** 展示用正文：正文里缺引用块时补上（其余情况原样返回）。 */
export function textWithQuote(entry) {
  const prefix = quotePrefixFor(entry);
  return prefix ? `${prefix}${entry?.text ?? ''}` : String(entry?.text ?? '');
}

/**
 * 按字符数截断，但不切断代理对（emoji 是两个 UTF-16 码元）。
 * 直接 slice 会在边界留下**孤立代理项**：JSON 里能表示，但整条请求会被模型网关判成
 * Bad Request 400（2026-09-27 实测：记忆"新建印象"把天气播报里的 emoji 切成两半，
 * 该成员永远建不出印象，控制台只看到"1 位失败"）。
 */
export function safeSlice(text, max) {
  const s = String(text ?? '');
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (s.length <= limit) return s;
  const last = limit > 0 ? s.charCodeAt(limit - 1) : 0;
  const cutsPair = last >= 0xd800 && last <= 0xdbff;   // 结尾正好是代理对的高位：少切一个
  return s.slice(0, cutsPair ? limit - 1 : limit);
}

/** 剥掉孤立代理项（只可能来自错误的截断/拼接）。请求前兜底清理，避免整次调用 400。 */
export function stripLoneSurrogates(text) {
  return String(text ?? '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

/** 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。 */
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch { /* 原样返回 */ }
  }
  return value;
}

/**
 * 把弱模型常见的"对象形态"消息解包回纯文本：
 *   {"text":"..."} / {"content":"..."} / {"message":"..."} → 取第一个字符串值
 *   content-parts（OpenAI 视觉格式 [{type:'text',text:...}]）→ 取 text 段拼接
 *   嵌套数组 → 拍平拼接
 * 返回 null = 解不出来（调用方应报错回模型，而不是把 "[object Object]" 发出去）。
 */
function unwrapMessage(m) {
  if (m === null || m === undefined) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(unwrapMessage).filter((x) => x !== null).join('\n');
  if (typeof m === 'object') {
    // content-parts：{type:'text', text:'...'} 或 {content:[{type:'text',...}]}
    if (m.type === 'text' && typeof m.text === 'string') return m.text;
    if (Array.isArray(m.content)) {
      return m.content.filter((p) => p && p.type === 'text').map((p) => String(p.text ?? '')).join('\n');
    }
    const v = m.text ?? m.content ?? m.message;
    if (typeof v === 'string') return v;
    return null;
  }
  return String(m);
}

/**
 * 把 messages 参数统一成字符串数组。兼容：
 *  - 字符串 / 字符串数组（正常路径）
 *  - JSON 字符串形态的数组、带引号的字符串（老兼容）
 *  - 双重编码的 JSON 对象字符串 "{\"text\":\"...\"}"（弱模型高发）
 *  - 对象 / 对象数组（弱模型高发，逐一解包）
 *  salvage 规则：能解出文本的条目照发；一条都解不出来才抛错 ——
 *  错误会作为工具结果回给模型，它在同一会话里可以自我纠正重发。
 */
export function normalizeMessageList(input) {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) value = parsed;
      } catch { /* 保持字符串 */ }
    } else if (trimmed.startsWith('"')) {
      const unquoted = unquoteJsonString(trimmed);
      if (typeof unquoted === 'string') value = unquoted;
    }
  }
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  const bad = [];
  for (const m of arr) {
    const unwrapped = unwrapMessage(m);
    if (unwrapped === null) { bad.push(m); continue; }
    const s = String(unwrapped).trim();
    if (s) out.push(s);
  }
  if (!out.length && bad.length) {
    throw new Error(`messages 必须是字符串或字符串数组，收到的是对象形态：${JSON.stringify(bad[0])?.slice(0, 120)}——请把消息文本直接作为字符串传入`);
  }
  return out;
}

/** 简单串行队列：保证发送按顺序、带间隔执行。 */
export function createSendChain() {
  let chain = Promise.resolve();
  return function enqueue(task) {
    const next = chain.then(task, task);
    // 防止单次失败中断整条链
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}

/** 简易事件总线。 */
export function createEventBus() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (error) { console.error(`[bus] ${type} 监听器出错:`, error); }
      }
    }
  };
}

/** 截断长文本（日志/会话记录展示用）。 */
export function truncate(text, max = 400) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…(共${s.length}字)`;
}
