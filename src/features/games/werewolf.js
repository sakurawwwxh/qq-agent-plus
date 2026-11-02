// 狼人杀（简化 6~9 人）：夜里私聊提交行动（守卫/狼队/预言家），白天在群里讨论与投票。
// 与谁是卧底的两个本质差异：
//   ① 私聊是**贯穿全程的行动通道**——玩家私聊机器人提交行动（onPrivateMessage），
//      Manager 在 ingest 入口接管这些消息并就地标记已读，不唤醒模型（省调用 + 零泄密面）；
//   ② 公开信息与隐藏信息严格分层——身份、夜晚行动、查验结果全部只走私聊，
//      公开摘要（summaryForModel）里只有存活名单与公开死讯。
// 行动格式：回**编号**（开局公告里 1=谁 …）或群名片，一字不差。重复提交 = 覆盖。
import { sanitizeUserText } from '../../core/util.js';

export const meta = {
  id: 'werewolf',
  name: '狼人杀',
  minPlayers: 6,
  maxPlayers: 9,
  needsPrivate: true,      // 发身份 + 夜里行动都要私聊（受 allowPrivateInvite / 游戏豁免开关门控）
  roundSeconds: 90,        // 夜行动窗口 / 每人发言 / 投票 各自的超时
  maxDurationMin: 60
};

// 角色表（按人数）：先狼、再预言家/女巫/守卫、其余平民。
// 女巫进表后 6 人局用"女巫"替掉守卫（保持 2 神 2 民），7 人起守卫也在。
const ROLE_TABLE = {
  6: ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'],
  7: ['wolf', 'wolf', 'seer', 'witch', 'guard', 'villager', 'villager'],
  8: ['wolf', 'wolf', 'seer', 'witch', 'guard', 'villager', 'villager', 'villager'],
  9: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'guard', 'villager', 'villager', 'villager']
};
const ROLE_NAME = { wolf: '狼人', seer: '预言家', guard: '守卫', witch: '女巫', villager: '平民' };
const MAX_NIGHTS = 6;
// 白天的固定讨论时长（秒）：到点直接进投票，不等谁。可在控制台改（groupGame.discussSeconds）。
const DAY_DISCUSS_SECONDS = 120;
// "想直接投票"的表达（没有具体目标时才算数；"投 3"那种是有目标的投票）
const READY_VOTE_RE = /(直接投|开始投票|可以投了?|赶紧投|快点投|投票吧|投吧|开投|别聊了|投得了)/;
// 每人每夜的回执上限：有人反复私聊刷行动时，超过就不再逐条回（静默消耗），
// 免得把对方的私聊刷爆、也免得触发协议端限频
const MAX_ACKS_PER_NIGHT = 4;
// 退出/观战：不想被拉进局的人（名单取的是"最近发过言的人"，难免有不想玩的）
// 退出：口语会带"我"和尾随说明（"我不玩了""不玩了，你们玩"），只认前缀 + 常见变体，
// 不做整句精确匹配（2026-09-29：最自然的"我不玩了"以前不认）
const QUIT_RE = /^\s*(?:我)?\s*(不玩了?|不玩啦|不参与|不参加|退出|退赛|弃权|观战|别带我|不凑热闹)/;

const aliveList = (state) => state.roles.filter((r) => r.alive);

export function create({ players, rng, now = 0, reveal = true, discussSeconds = 0, roundSeconds = 0 } = {}) {
  const rand = typeof rng === 'function' ? rng : Math.random;
  const list = (players || []).map((p) => ({
    userId: String(p.userId),
    // 群名片是用户可控文本，进提示词/播报前统一清洗（伪造段头穿透，与卧底同口径）
    name: sanitizeUserText(String(p.name || p.userId))
  }));
  const table = ROLE_TABLE[list.length] || ROLE_TABLE[6];
  const shuffled = [...list];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const roles = shuffled.map((p, i) => ({ ...p, role: table[i] || 'villager', alive: true }));
  return {
    phase: 'night',
    reveal: reveal !== false,   // 结算是否公开身份与夜晚记录（控制台那个勾）
    discussSeconds: Math.min(600, Math.max(30, Number(discussSeconds) || DAY_DISCUSS_SECONDS)),
    // 夜行动/投票窗口（控制台「单回合超时」）：0 = 用插件默认 90 秒。以前这配置对狼人杀完全不生效
    roundSeconds: Number(roundSeconds) > 0 ? Math.min(600, Math.max(30, Number(roundSeconds))) : 0,
    readyVote: [],              // 白天说过"投吧/直接投"的人（过半就立刻开投）
    night: 1,
    roles,
    order: roles.map((r) => r.userId),
    cursor: 0,
    pending: { guard: '', wolves: {}, seer: '', witch: null, killTarget: '' },   // 本夜已收到的行动
    // 女巫的两瓶药（各一次；解药救今晚被刀的人、毒药毒一个人；一晚只用一瓶、不能自救）
    potions: { heal: true, poison: true },
    ackCount: {},                                    // 每人每夜的回执计数（防刷屏）
    nightLog: [],                                    // 每晚结算，结束时公布
    phaseStartedAt: now,
    votes: {},
    maxNights: MAX_NIGHTS
  };
}

const idxOf = (state, r) => state.roles.indexOf(r) + 1;
const aliveOf = (state, role) => state.roles.filter((r) => r.role === role && r.alive);

/** 解析"守/刀/查 3"这类行动：编号（1..N）或群名片，歧义/不在场返回 null。 */
function parseTarget(state, text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // 整句匹配（可带动词/编号后缀）：夜里私聊"我 3 点再聊""1 个人在吗"不能被当成"守/刀/查 3 号"
  // （2026-09-29 审查 P2；旧实现是裸 \d{1,2} 不锚定）
  const m = /^(?:守|刀|杀|查|毒|救|解毒|我选|选择|投)?\s*@?\s*(\d{1,2})\s*号?\s*[!！。.~～…]?$/.exec(t);
  if (m) {
    const idx = Number(m[1]);
    if (idx >= 1 && idx <= state.roles.length) {
      const hit = state.roles[idx - 1];
      return hit && hit.alive ? hit : null;
    }
    return null;
  }
  // 名片：允许"守 阿猫"或直接"阿猫"（整句）；也接受 "投 @阿猫" 的 @ 前缀
  const bare = t.replace(/^(守|刀|杀|查|毒|救|解毒|我选|选择|投)\s*/g, '')
    .replace(/^@\s*/, '')
    .replace(/\s*[!！。.~～…]$/, '').trim();
  return state.roles.find((r) => r.alive && (
    r.name === t.replace(/^@\s*/, '').replace(/\s*[!！。.~～…]$/, '') || r.name === bare
  )) || null;
}

/** 夜晚行动提示（开局与每晚结算后各发一次）。 */
function nightPrompts(state) {
  const eff = [];
  const guard = aliveOf(state, 'guard')[0];
  const seer = aliveOf(state, 'seer')[0];
  const wolves = aliveOf(state, 'wolf');
  if (guard) {
    const ban = state.lastGuard ? `（昨晚守了 ${idxOf(state, state.roles.find((r) => r.userId === state.lastGuard))} 号，今晚不能连守）` : '';
    eff.push({ type: 'private', userId: guard.userId, text: `【狼人杀】第 ${state.night} 夜·守卫行动：你要守谁？回编号或群名片${ban}。不回就当你今晚不守。` });
  }
  if (wolves.length) {
    for (const w of wolves) {
      const mates = wolves.filter((x) => x.userId !== w.userId).map((x) => x.name).join('、');
      eff.push({ type: 'private', userId: w.userId, text: `【狼人杀】第 ${state.night} 夜·狼队行动：你们刀谁？回编号或群名片（队友：${mates || '只有你'}）。不回就当你弃权。` });
    }
  }
  if (seer) {
    eff.push({ type: 'private', userId: seer.userId, text: `【狼人杀】第 ${state.night} 夜·预言家行动：你要查谁？回编号或群名片，我立刻把结果发给你。` });
  }
  // 女巫：这里只提醒"有药待用"，具体问法要等狼刀定了再发（witchPrompt）——
  // 她得先知道今晚谁被刀才好决定救不救
  const witch = aliveOf(state, 'witch')[0];
  if (witch) {
    const p = state.potions || {};
    eff.push({
      type: 'private',
      userId: witch.userId,
      text: `【狼人杀】第 ${state.night} 夜·女巫：你${p.heal ? '有解药' : '的解药已用完'}、${p.poison ? '有毒药' : '的毒药已用完'}。`
        + '狼刀定下来我就告诉你是谁被刀，到时候回「救」/「不救」/「毒 3」。'
    });
  }
  return eff;
}

/** 狼队刀口：多数一致；平票在并列目标里随机（结算与"告知女巫"必须用同一个目标）。 */
function wolfTargetOf(state, rng = Math.random) {
  const rand = typeof rng === 'function' ? rng : Math.random;
  const counts = new Map();
  for (const uid of Object.values(state.pending?.wolves || {})) {
    if (!uid) continue;
    counts.set(uid, (counts.get(uid) || 0) + 1);
  }
  if (!counts.size) return '';
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const best = top.filter(([, n]) => n === top[0][1]);
  return best[Math.floor(rand() * best.length)][0];
}

/** 女巫行动提示：狼刀定了之后才问（告诉她是几号被刀）。 */
function witchPrompt(state) {
  const witch = aliveOf(state, 'witch')[0];
  if (!witch || state.pending?.witch) return [];
  const target = state.roles.find((r) => r.userId === String(state.pending?.killTarget || ''));
  const p = state.potions || {};
  const who = target ? `${idxOf(state, target)} 号 ${target.name}` : '没有人';
  if (String(state.pending?.killTarget || '') === witch.userId) {
    // 被刀的是她自己：救这条路封死，剩什么药说什么药（都没了就别再让她在两个提示之间打转）
    const tail = p.poison
      ? '你只能选择：不救，或者用毒药毒一个人（回「毒 3」）。'
      : (p.heal ? '解药没法用在自己身上（不能自救），毒药也用完了——回「不救」继续就行。'
        : '你两瓶药都用完了，回「不救」继续就行。');
    return [{ type: 'private', userId: witch.userId, text: `【狼人杀】今晚被刀的是你自己（${who}）。简化规则里女巫**不能自救**，${tail}` }];
  }
  const bits = [`【狼人杀】女巫行动：今晚被刀的是 ${who}。`];
  if (p.heal) bits.push('要用解药救他吗？回「救」或「不救」。');
  if (p.poison) bits.push('要下毒就回「毒 3」这样的编号（解药和毒药**一晚只能用一瓶**）。');
  if (!p.heal && !p.poison) bits.push('你两瓶药都用完了，回「不救」继续就行。');
  return [{ type: 'private', userId: witch.userId, text: bits.join('') }];
}

/** 开局效果：公开公告（含编号名单）+ 逐个私聊发身份 + 第 1 夜行动提示。 */
export function openingEffects(state) {
  const list = state.roles.map((r, i) => `${i + 1}=${r.name}`).join('、');
  const eff = [{
    type: 'public',
    text: `🐺 狼人杀开局：${state.roles.length} 人 —— ${list}。身份已私聊给各位（狼队互相可见），`
      + '夜里按私聊提示回行动，白天在群里讨论、发「投 3」投票。没收到身份的私下告诉我。'
  }];
  for (const r of state.roles) {
    const mates = aliveOf(state, 'wolf').filter((w) => w.userId !== r.userId).map((w) => `${idxOf(state, w)} 号 ${w.name}`);
    const text = r.role === 'wolf'
      ? `【狼人杀】你是**狼人**。${mates.length ? `队友：${mates.join('、')}。` : ''}每晚我会私聊问你刀谁（狼队各自回，多数一致生效）。`
      : (r.role === 'seer' ? '【狼人杀】你是**预言家**。每晚可查一个人是"狼人/好人"，结果只发给你。'
        : (r.role === 'guard' ? '【狼人杀】你是**守卫**。每晚可守一个人免于狼刀（可以守自己，但不能连着两晚守同一人）。'
          : (r.role === 'witch'
            ? '【狼人杀】你是**女巫**。你有一瓶**解药**（救今晚被刀的人）和一瓶**毒药**（毒一个人），各只能用一次，'
              + '一晚最多用一瓶、不能救自己；狼刀定了我会私聊问你怎么用。'
            : '【狼人杀】你是**平民**。夜里没有行动，白天靠讨论与投票找出狼人来。')));
    eff.push({ type: 'private', userId: r.userId, text });
  }
  eff.push(...nightPrompts(state));
  return eff;
}

/** 夜里行动是否都收齐了（收齐就立刻结算，不干等超时）。 */
function nightReady(state) {
  const need = [];
  const guard = aliveOf(state, 'guard')[0];
  const seer = aliveOf(state, 'seer')[0];
  const witch = aliveOf(state, 'witch')[0];
  const wolves = aliveOf(state, 'wolf');
  if (guard) need.push(Boolean(state.pending.guard));
  if (seer) need.push(Boolean(state.pending.seer));
  for (const w of wolves) need.push(Boolean(state.pending.wolves[w.userId]));
  // 女巫只有在"狼刀已定、问过她"之后才算需要提交（狼没交齐时她不被问，也就不算欠行动）。
  // 但她要是根本没有可选动作（两瓶药都用完，或只剩解药却被刀的是她自己），就不该再等她回话——
  // 否则这一夜白等 90 秒超时（2026-09-29 审查 P2）
  if (witch && state.pending.killTarget) {
    const p = state.potions || {};
    const selfHit = String(state.pending.killTarget) === witch.userId;
    const hasChoice = (p.heal && !selfHit) || p.poison;
    need.push(!hasChoice || state.pending.witch !== null);
  }
  return need.every(Boolean);
}

/**
 * 玩家退出（"不玩了/退出/观战"）：移出本局、不公布身份，重算胜负。
 * 名单取"最近发过言的人"，难免拉进不想玩的人——必须给一条体面的退路。
 */
function quitPlayer(state, me, now = 0, rng = Math.random) {
  const s = JSON.parse(JSON.stringify(state));
  const target = s.roles.find((r) => r.userId === me.userId);
  if (!target || !target.alive) {
    return { state: s, effects: [{ type: 'private', userId: me.userId, text: '【狼人杀】你本来就不在局里（或已经出局），不用退出。' }] };
  }
  target.alive = false;
  target.quit = true;
  // 退出即作废：本夜已交的行动、本白天已投的票、以及"发过言/想开投"的记录都不再算数
  // （2026-09-29 审查 P1/P2：退出的狼仍参与多数刀、退出的票仍能把人投出）
  delete s.pending.wolves[me.userId];
  // pending.guard / pending.seer 里存的是**目标**，不是提交者 —— 原来拿 me.userId 去比，
  // 只有"守自己/查自己"才命中：退出的守卫照样挡刀（死人的行动改了谁活谁死；2026-09-29 对抗性验证 P1）
  if (target.role === 'guard') s.pending.guard = '';
  if (target.role === 'seer') s.pending.seer = '';
  // 女巫退出：她本夜已交的药作废（否则"人不在了药还生效、还照扣"——与"药水随人作废"相反）
  if (target.role === 'witch') s.pending.witch = null;
  delete s.votes[me.userId];
  s.spoken = (s.spoken || []).filter((x) => x !== me.userId);
  s.readyVote = (s.readyVote || []).filter((x) => x !== me.userId);
  // 别人投给他的票也作废（对已退出的人计票会把"幽灵"投出局）
  for (const [voter, victim] of Object.entries(s.votes)) {
    if (victim === me.userId) delete s.votes[voter];
  }
  const effects = [
    { type: 'private', userId: me.userId, text: '【狼人杀】好，把你移出本局了，接下来你可以正常聊天或围观（不会给你发行动提示）。' },
    { type: 'public', text: `👋 ${target.name} 退出了本局（不计胜负、身份不公布），剩下 ${aliveList(s).length} 人继续。` }
  ];
  // 狼队在锁刀前减员：活着的狼要是有刀都交了，就地把刀口定下来并问女巫。
  // 不补这一步的话 killTarget 永远是空的 → 她的回合被静默吞掉（不问她、也不能用药；
  // 2026-09-29 对抗性验证 P2）
  if (s.phase === 'night' && !s.pending.killTarget) {
    const wolvesLeft = aliveOf(s, 'wolf');
    if (wolvesLeft.length && wolvesLeft.every((w) => s.pending.wolves[w.userId])) {
      s.pending.killTarget = wolfTargetOf(s, rng);
      effects.push(...witchPrompt(s));
    }
  }
  const win = checkWin(s);
  if (win) return { state: { ...s, phase: 'ended' }, effects: [...effects, winEffect(s, win)] };
  // 退出的正好是当前该行动的人：别的行动都齐了就立刻结算
  if (s.phase === 'night' && nightReady(s)) {
    const out = resolveNight(s, rng, now);
    return { state: out.state, effects: [...effects, ...out.effects] };
  }
  // 退出的正好是本阶段唯一欠动作/欠票的那个人：白天全员发完言就直接进投票，投票全员投完就结算。
  // 不补这两条会一直干等到窗口超时（白天 120 秒 / 投票 90 秒），群里看着像卡住
  // （卧底插件对同一场景有等价重算；2026-09-29 审查 P2）。
  if (s.phase === 'day') {
    const alive = aliveList(s);
    const allVoted = alive.every((r) => s.votes[r.userId]);
    const majorityReady = alive.length > 0 && (s.readyVote || []).length * 2 > alive.length;
    if (allVoted) {
      const out = tally(s, now);
      return { state: out.state, effects: [...effects, ...out.effects] };
    }
    if (alive.length > 0 && ((s.spoken || []).length >= alive.length || majorityReady)) {
      s.phase = 'vote';
      s.phaseStartedAt = now;
      effects.push({ type: 'public', text: `剩下的人都聊过了，开始投票：发「投 3」或「投 @他」都行（存活的 ${alive.length} 人各一票）。` });
    }
  } else if (s.phase === 'vote') {
    const aliveIds = aliveList(s).map((r) => r.userId);
    if (aliveIds.length && aliveIds.every((x) => s.votes[x])) {
      const out = tally(s, now);
      return { state: out.state, effects: [...effects, ...out.effects] };
    }
  }
  return { state: s, effects };
}

/** 结算夜晚：守卫挡刀 → 平安夜；否则狼刀目标出局；公布死讯（不公布身份）。 */
function resolveNight(state, rng = Math.random, now = 0) {
  const s = JSON.parse(JSON.stringify(state));
  const rand = typeof rng === 'function' ? rng : Math.random;
  // 狼队：多数一致；平票在并列目标里随机。有"已定的刀口"（告知过女巫）必须沿用同一个，
  // 否则会出现"告诉她刀 3、结算却刀 5"这种自相矛盾。
  const target = String(s.pending.killTarget || wolfTargetOf(s, rand) || '');
  const guarded = String(s.pending.guard || '');
  const byUid = (uid) => s.roles.find((r) => r.userId === uid);
  const witchRole = aliveOf(s, 'witch')[0];
  const witchAct = s.pending.witch || null;
  const healUsed = Boolean(target) && witchAct?.use === 'heal';
  const poisonTarget = witchAct?.use === 'poison' ? String(witchAct.target || '') : '';
  // 守卫挡刀 + 女巫解药：任一命中即可活；**同守同救必死**（主流规则，防"双保险"让狼刀失效）
  const guardedHit = Boolean(target) && target === guarded;
  const savedOnce = guardedHit !== healUsed;              // 恰好一种保护生效才算活
  const died = target && !savedOnce ? target : '';
  // 毒药照常致命（和狼刀可以带走两个人）
  const poisonVictim = poisonTarget ? String(poisonTarget) : '';
  const guardRole = aliveOf(s, 'guard')[0];
  const seerRole = aliveOf(s, 'seer')[0];
  const seerTarget = s.roles.find((r) => r.userId === String(s.pending.seer || ''));
  const detail = {
    night: s.night,
    guard: guardRole && s.pending.guard ? idxOf(s, byUid(String(s.pending.guard))) : 0,
    wolf: target ? idxOf(s, byUid(target)) : 0,
    heal: healUsed && witchRole ? idxOf(s, byUid(target)) : 0,
    poison: poisonVictim ? idxOf(s, byUid(poisonVictim)) : 0,
    seer: seerRole && seerTarget ? idxOf(s, seerTarget) : 0,
    seerSawWolf: seerRole && seerTarget ? seerTarget.role === 'wolf' : null,
    died: died ? idxOf(s, byUid(died)) : 0
  };
  s.lastGuard = s.pending.guard || '';
  // 药水在**结算时**才扣（中途改主意/覆盖不浪费药）
  if (witchAct?.use === 'heal') s.potions = { ...(s.potions || {}), heal: false };
  if (witchAct?.use === 'poison') s.potions = { ...(s.potions || {}), poison: false };
  const effects = [];
  const deadNames = [];
  const deadIdx = [];
  const deadRoles = [];
  for (const uid of [...new Set([died, poisonVictim].filter(Boolean))]) {
    const victim = byUid(uid);
    if (!victim || !victim.alive) continue;
    victim.alive = false;
    deadNames.push(victim.name);
    deadIdx.push(idxOf(s, victim));
    deadRoles.push(victim);
  }
  // 真正出局的编号：只狼刀（died）不够——毒杀不进 died，被刀/被毒的人在结算前退出又不会真的死，
  // summaryForModel 只看 died 会把"毒死一个"报成"昨夜平安"、把"退了没死"报成"昨夜 N 号出局"
  // （2026-09-29 审查 P1）
  detail.dead = deadIdx;
  s.nightLog = [...(s.nightLog || []), detail];
  if (deadNames.length) {
    effects.push({ type: 'public', text: `🌅 天亮了（第 ${s.night} 夜）：${deadNames.join('、')} 昨晚倒牌，身份不公布。可以说遗言，然后开始讨论。` });
  } else {
    effects.push({ type: 'public', text: `🌅 天亮了（第 ${s.night} 夜）：平安夜，昨晚没有人出局。` });
  }
  // 逐个私聊通知出局者本人（退出的已经收过告别，不重复发）
  for (const v of deadRoles) if (!v.quit) effects.push(deathNotice(v));
  s.pending = { guard: '', wolves: {}, seer: '', witch: null, killTarget: '' };
  s.ackCount = {};
  s.selfVoteWarned = [];
  // readyVote 是"今天想开投的人"，跨天必须清：不清的话第 2 天随便有人说句话就立刻开投，
  // 讨论时长被整段跳过（2026-09-29 审查 P1）
  s.readyVote = [];
  const win = checkWin(s);
  if (win) return { state: { ...s, phase: 'ended' }, effects: [...effects, winEffect(s, win)] };
  s.phase = 'day';
  s.cursor = 0;
  s.order = aliveList(s).map((r) => r.userId);   // 只用于"第几号人"的展示
  s.spoken = [];                                  // 本白天说过话的人（谁想说就说）
  s.dayWarned = false;                            // 新的一天：倒计时提醒可以再发一次
  s.votes = {};
  // 计时起点必须在天亮这一刻就设：置 0 会让 onTick 里 `Number(0) || now` 恒等于 now，
  // 白天第一个发言者 AFK 时 90 秒超时永不生效（与卧底第 2 轮同款坑，2026-09-29）
  s.phaseStartedAt = now || 0;
  const aliveNames = aliveList(s).map((r) => r.name).join('、');
  const secs = Number(s.discussSeconds) || DAY_DISCUSS_SECONDS;
  effects.push({
    type: 'public',
    text: `第 ${s.night} 天讨论：存活 ${aliveNames}。想说什么就说（不用等点名），也可以直接发「投 3」带票；`
      + `${secs} 秒后自动开始投票，中途**超过半数人说一句「投吧」也会立刻开始**。`
  });
  return { state: s, effects };
}

/** 胜负：狼全灭=好人胜；狼数 ≥ 好人数=狼胜。 */
function checkWin(state) {
  const wolves = state.roles.filter((r) => r.role === 'wolf' && r.alive).length;
  const good = state.roles.filter((r) => r.role !== 'wolf' && r.alive).length;
  if (!wolves) return 'good';
  if (wolves >= good) return 'wolf';
  return '';
}

function winEffect(state, win) {
  const head = win === 'wolf' ? '狼人获胜' : '好人获胜';
  if (state.reveal === false) return { type: 'end', result: `${head}（本局未公开身份）。` };
  const roles = state.roles.map((r, i) => `${i + 1}=${r.name}（${ROLE_NAME[r.role]}${r.alive ? '' : '·已出局'}）`).join('，');
  const nights = (state.nightLog || [])
    .map((n) => `第 ${n.night} 夜：守${n.guard || '-'}／刀${n.wolf || '-'}${n.heal ? `／救${n.heal}` : ''}${n.poison ? `／毒${n.poison}` : ''}${n.seer ? `／查${n.seer}${n.seerSawWolf ? '（狼）' : '（好人）'}` : ''}`)
    .join('；');
  return {
    type: 'end',
    result: `${head}。身份：${roles}。${nights ? `夜晚记录：${nights}` : ''}`
  };
}

/** 出局私聊：说清"你已经出局、之后的发言与投票都不再计入"——
 * 群里没人拦得住死人的嘴（真人局也一样），但至少别让他以为自己的票还算数。 */
function deathNotice(role) {
  return {
    type: 'private',
    userId: role.userId,
    text: '【狼人杀】你出局了（身份不公布）。可以在群里说遗言、继续围观；'
      + '之后你在群里的发言与「投 X」都不再计入本局。'
  };
}

/** 白天投票结算：票高者出局；平票本轮不出人。 */
function tally(state, now = 0) {
  const s = JSON.parse(JSON.stringify(state));
  const aliveIds = new Set(aliveList(s).map((r) => r.userId));
  const counts = new Map();
  for (const [voter, target] of Object.entries(s.votes)) {
    // 只有"还活着的人投给还活着的人"才算数（退出的投票人/被投的已退出者都作废）
    if (!aliveIds.has(voter) || !aliveIds.has(target)) continue;
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  const effects = [];
  if (!counts.size) {
    effects.push({ type: 'public', text: '这轮没人投票，直接进入下一夜。' });
    return toNight(s, effects, now);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.filter(([, n]) => n === ranked[0][1]).length > 1) {
    effects.push({ type: 'public', text: `平票（各 ${ranked[0][1]} 票），本轮不出人，直接进入下一夜。` });
    return toNight(s, effects, now);
  }
  const out = s.roles.find((r) => r.userId === ranked[0][0]);
  out.alive = false;
  effects.push({ type: 'public', text: `🗳 投票结果：${out.name} 出局（${ranked[0][1]} 票），身份不公布。要留遗言就现在。` });
  effects.push(deathNotice(out));
  const win = checkWin(s);
  if (win) return { state: { ...s, phase: 'ended' }, effects: [...effects, winEffect(s, win)] };
  return toNight(s, effects, now);
}

function toNight(state, effects, now = 0) {
  const s = { ...state, phase: 'night', night: (state.night || 1) + 1, cursor: 0, votes: {}, selfVoteWarned: [], phaseStartedAt: now || 0 };
  if (s.night > (state.maxNights || MAX_NIGHTS)) {
    const tail = s.reveal === false ? '' : `身份：${s.roles.map((r, i) => `${i + 1}=${r.name}（${ROLE_NAME[r.role]}）`).join('，')}`;
    return { state: { ...s, phase: 'ended' }, effects: [...effects, { type: 'end', result: `夜晚数用尽，本局平局。${tail}` }] };
  }
  const aliveNames = aliveList(s).map((r) => r.name).join('、');
  effects.push({ type: 'public', text: `🌙 天黑请闭眼（第 ${s.night} 夜，存活：${aliveNames}）。` });
  effects.push(...nightPrompts(s));
  return { state: s, effects };
}

/** 群消息：白天的发言轮与投票（夜里群里闲聊不参与判定）。 */
export function onMessage(state, msg, { now = 0, rng = Math.random } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const uid = String(msg.userId);
  const me = s.roles.find((r) => r.userId === uid);
  if (!me || s.phase === 'ended') return { state: s, effects: [] };
  // 群里说"不玩了"同样受理（有人只习惯在群里说话）
  if (me.alive && QUIT_RE.test(String(msg.text || '').trim())) return quitPlayer(s, me, now, rng);
  if (!me.alive) return { state: s, effects: [] };

  if (s.phase === 'day') {
    // 真人不会按点名顺序说话：**谁想说就说**，谁说过一句就算发过言（不排顺序、不催人）；
    // 所有人都说过、或到时间了 → 进投票。群里话多的人多刷几条不影响（去重靠 spoken 集合）。
    s.spoken = Array.isArray(s.spoken) ? s.spoken : [];
    s.readyVote = Array.isArray(s.readyVote) ? s.readyVote : [];
    if (!s.spoken.includes(uid)) s.spoken.push(uid);
    // 边说边投的也认：发言阶段出现的"投 3"直接记成他的票（结算时不用再催）
    const early = voteTargetOf(s, uid, msg.text);
    if (early) s.votes[uid] = early;
    // "投吧/直接投"这类**没有目标**的表态 = 想开投：超过半数就立刻进投票
    if (!early && READY_VOTE_RE.test(String(msg.text || '')) && !s.readyVote.includes(uid)) s.readyVote.push(uid);
    const alive = aliveList(s);
    const allVoted = alive.every((r) => s.votes[r.userId]);
    const majorityReady = alive.length > 0 && s.readyVote.length * 2 > alive.length;
    if (s.spoken.length >= alive.length || allVoted || majorityReady) {
      if (allVoted) return tally(s, now);
      s.phase = 'vote';
      // 发言阶段提前投的票**要留着**（真人常常边说边投；清掉等于把票丢了）
      s.votes = s.votes && typeof s.votes === 'object' ? s.votes : {};
      s.phaseStartedAt = now;
      const why = majorityReady && s.spoken.length < alive.length ? `过半人想投票（${s.readyVote.length}/${alive.length}）` : '都聊得差不多了';
      return { state: s, effects: [{ type: 'public', text: `${why}，开始投票：发「投 3」或「投 @他」都行（存活的 ${alive.length} 人各一票）。` }] };
    }
    return { state: s, effects: [] };
  }

  if (s.phase === 'vote') {
    const voteMatch = /投\s*@?([^\s，。！？!?,.]{1,12})/.exec(String(msg.text || ''));
    if (!voteMatch) return { state: s, effects: [] };
    const picked = parseTarget(s, voteMatch[1]);
    if (!picked) return { state: s, effects: [] };
    if (picked.userId === uid) {
      // 同一阶段每人只提醒一次：否则反复「投 自己」能把群消息刷爆（群配额被它吃光后，
      // 引擎自己的"天亮了/投票结果"反而发不出去，群里看着像卡住；2026-09-29 对抗性验证 P1）
      s.selfVoteWarned = Array.isArray(s.selfVoteWarned) ? s.selfVoteWarned : [];
      if (s.selfVoteWarned.includes(uid)) return { state: s, effects: [] };
      s.selfVoteWarned.push(uid);
      return { state: s, effects: [{ type: 'public', text: `${me.name} 想投自己？那不算，换一个。` }] };
    }
    s.votes[uid] = picked.userId;
    const aliveIds = aliveList(s).map((r) => r.userId);
    if (aliveIds.every((x) => s.votes[x])) return tally(s, now);
    return { state: s, effects: [] };
  }

  return { state: s, effects: [] };   // 夜里不看群消息
}

/** 从一条群消息里解析投票目标（"投 3"/"投 @阿狗"）；投自己不算，返回目标 userId 或 ''。 */
function voteTargetOf(state, uid, text) {
  const m = /投\s*@?([^\s，。！？!?,.]{1,12})/.exec(String(text || ''));
  if (!m) return '';
  const picked = parseTarget(state, m[1]);
  if (!picked || picked.userId === uid) return '';
  return picked.userId;
}

/** 私聊行动：夜里按角色收行动，收到就回执；解析不了返回空 effects（交回普通链路兜底）。 */
export function onPrivateMessage(state, msg, { now = 0, rng = Math.random } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const uid = String(msg.userId);
  const me = s.roles.find((r) => r.userId === uid);
  if (!me) return { state: s, effects: [] };
  // 局已结束（终局播报还在发的那几秒里进来的私聊）：不再受理任何行动，
  // 否则会在"狼人杀结束"之后再播一次"👋 X 退出了本局"、甚至多发一条终局播报（2026-09-29 审查 P2）
  if (s.phase === 'ended') return { state: s, effects: [] };
  // 退出/观战：任何阶段都受理（名单是"最近发过言的人"，有人并不想玩）。
  // 但只有**还在局里**的人才走退出路径：否则已出局的人反复发「不玩了」，
  // 每条都能拿一条私聊回执，把"每人每夜最多 4 条"整条绕开（2026-09-29 对抗性验证 P1）
  const wantsQuit = QUIT_RE.test(String(msg.text || '').trim());
  if (wantsQuit && me.alive) return quitPlayer(s, me, now, rng);
  if (s.phase !== 'night') return { state: s, effects: [] };   // 白天私聊照常聊天
  if (!me.alive) {
    // 出局的玩家夜里私聊：明确告诉他没行动，别去猜活人的事（同样受配额，防刷屏）
    const seen = Number(s.ackCount?.[uid] || 0);
    s.ackCount = { ...(s.ackCount || {}), [uid]: seen + 1 };
    if (seen >= MAX_ACKS_PER_NIGHT) return { state: s, effects: [], consume: true };
    return { state: s, effects: [{ type: 'private', userId: uid, text: wantsQuit
      ? '【狼人杀】你本来就不在局里（或已经出局），不用退出——安心等到局末看身份吧。'
      : '【狼人杀】你已经出局了，夜里没有行动，安心等到局末看身份吧。' }] };
  }
  // 回执配额（每人每夜最多几条）：满了就静默消耗——行动照收，不再逐条回消息，
  // 免得有人反复私聊把对方私聊刷爆、或触发协议端限频
  const acks = Number(s.ackCount?.[uid] || 0);
  const canAck = acks < MAX_ACKS_PER_NIGHT;
  s.ackCount = { ...(s.ackCount || {}), [uid]: acks + 1 };
  // effects 在这里声明：女巫分支被提到通用解析之前，也在用它（2026-09-29）
  const effects = [];
  if (me.role === 'villager') {
    return canAck
      ? { state: s, effects: [{ type: 'private', userId: uid, text: '【狼人杀】夜里你没有行动，安心等到天亮（有话白天在群里说）。' }] }
      : { state: s, effects: [], consume: true };
  }
  if (me.role === 'witch') {
    // 女巫：狼刀未定时不接行动；定下来后按「救 / 不救 / 毒 3」处理
    if (!s.pending.killTarget) {
      return canAck
        ? { state: s, effects: [{ type: 'private', userId: uid, text: '【狼人杀】狼刀还没定，等我叫你（别急，很快）。' }] }
        : { state: s, effects: [], consume: true };
    }
    const text = String(msg.text || '').trim();
    const potions = s.potions || {};
    const killTarget = s.roles.find((r) => r.userId === String(s.pending.killTarget));
    if (/^(不救|不用|不用了|算了|过)/.test(text)) {
      // 「不救」= 今晚不用药：若她刚选了毒也一并撤销（宁可让她补一句，也不能在她改口后照旧下毒）
      const hadPoison = s.pending.witch?.use === 'poison';
      s.pending.witch = { use: 'none' };
      if (canAck) effects.push({ type: 'private', userId: uid, text: hadPoison
        ? '✔ 记下了：今晚不用药（刚才选的毒药也取消了；要下毒再回「毒 3」）。'
        : '✔ 记下了：今晚不用药。' });
    } else if (/^(救|解药|用解药|救人|救他|要救)/.test(text)) {
      // 下面这些"提醒类"回执也要吃配额：否则反复发「救」能刷出无限条私聊（协议端限频 + 扰民）
      if (String(s.pending.killTarget) === uid) {
        return canAck
          ? { state: s, effects: [{ type: 'private', userId: uid, text: '【狼人杀】简化规则：女巫**不能救自己**。你可以回「不救」，或者用毒药毒一个人（「毒 3」）。' }] }
          : { state: s, effects: [], consume: true };
      }
      if (!potions.heal) {
        return canAck
          ? { state: s, effects: [{ type: 'private', userId: uid, text: potions.poison
            ? '【狼人杀】你的解药已经用过了。可以回「不救」，或者用毒药（「毒 3」）。'
            : '【狼人杀】你的解药已经用过了、毒药也没有了，回「不救」继续就行。' }] }
          : { state: s, effects: [], consume: true };
      }
      s.pending.witch = { use: 'heal' };
      if (canAck) effects.push({ type: 'private', userId: uid, text: `✔ 记下了：用解药救 ${killTarget ? `${idxOf(s, killTarget)} 号 ${killTarget.name}` : '今晚被刀的人'}。` });
    } else if (/^(下毒|毒药|用毒|毒)/.test(text)) {
      if (!potions.poison) {
        // 她是被刀的人时不能再劝她「救」——那条路被"不能自救"堵死，会变成死循环
        const selfHit = String(s.pending.killTarget) === uid;
        return canAck
          ? { state: s, effects: [{ type: 'private', userId: uid, text: selfHit
            ? '【狼人杀】你的毒药已经用过了；你又是今晚被刀的人、不能自救，回「不救」继续就行。'
            : '【狼人杀】你的毒药已经用过了。要救今晚被刀的人就回「救」。' }] }
          : { state: s, effects: [], consume: true };
      }
      const victim = parseTarget(s, text.replace(/^(下毒|毒药|用毒|毒)\s*/, ''));
      if (!victim) {
        return canAck
          ? { state: s, effects: [{ type: 'private', userId: uid, text: '【狼人杀】没看懂毒谁：回「毒 3」这样的编号或群名片。' }] }
          : { state: s, effects: [], consume: true };
      }
      if (victim.userId === uid) {
        return canAck
          ? { state: s, effects: [{ type: 'private', userId: uid, text: '【狼人杀】不能毒自己，换一个。' }] }
          : { state: s, effects: [], consume: true };
      }
      s.pending.witch = { use: 'poison', target: victim.userId };
      if (canAck) effects.push({ type: 'private', userId: uid, text: `✔ 记下了：今晚毒 ${idxOf(s, victim)} 号 ${victim.name}（一晚只能用一瓶药，这条会覆盖前面的选择）。` });
    } else {
      return canAck
        ? { state: s, effects: [{ type: 'private', userId: uid, text: `【狼人杀】回「救」「不救」或用「毒 3」选个人下毒${killTarget ? `（今晚被刀的是 ${idxOf(s, killTarget)} 号）` : ''}。` }] }
        : { state: s, effects: [], consume: true };
    }
    // 女巫的行动到此为止：别再落到下面的通用解析（那会把回执冲成"没看懂"、状态改了却不回话）
    if (nightReady(s)) {
      const out = resolveNight(s, rng, now);
      return { state: out.state, effects: [...effects, ...out.effects] };
    }
    return { state: s, effects, consume: !canAck && effects.length === 0 };
  }

  const target = parseTarget(s, msg.text);
  if (!target) {
    return canAck
      ? { state: s, effects: [{ type: 'private', userId: uid, text: `【狼人杀】没看懂你的行动：回 1~${s.roles.length} 的编号或群名片都行（例如「${me.role === 'wolf' ? '刀' : me.role === 'seer' ? '查' : '守'} 3」）。` }] }
      : { state: s, effects: [], consume: true };
  }
  // 同一目标的重复提交：静默消耗（第一次已经回过执了，别再刷对方的私聊）
  const sameAsBefore = (me.role === 'guard' && s.pending.guard === target.userId)
    || (me.role === 'wolf' && s.pending.wolves[uid] === target.userId)
    || (me.role === 'seer' && s.pending.seer === target.userId);
  if (sameAsBefore) return { state: s, effects: [], consume: true };

  if (me.role === 'guard') {
    if (s.lastGuard && String(s.lastGuard) === target.userId) {
      return { state: s, effects: canAck ? [{ type: 'private', userId: uid, text: '【狼人杀】不能连着两晚守同一个人，今晚换一个。' }] : [], consume: !canAck };
    }
    s.pending.guard = target.userId;
    if (canAck) effects.push({ type: 'private', userId: uid, text: `✔ 已记下：今晚守 ${idxOf(s, target)} 号 ${target.name}。` });
  } else if (me.role === 'wolf') {
    // 刀口一旦定下（女巫已经被告知是谁）就不能再改：否则女巫先看到"刀的是 A"、再收到一条
    // "刀的是 B"，她按第一条做的决定就跟结算对不上（2026-09-29 模拟测出来的）
    if (s.pending.killTarget) {
      return {
        state: s,
        effects: canAck ? [{ type: 'private', userId: uid, text: '【狼人杀】刀口已经定下（女巫知道是谁了），今晚改不了啦；下一晚再说。' }] : [],
        consume: !canAck
      };
    }
    s.pending.wolves[uid] = target.userId;
    if (canAck) effects.push({ type: 'private', userId: uid, text: `✔ 已记下你的刀口：${idxOf(s, target)} 号 ${target.name}（狼队各自提交，多数一致生效；定下来之前可以再发一条改）。` });
    // 狼队全交齐了 → 刀口定下来，立刻去问女巫（她得先知道谁被刀才好决定救不救）
    const wolves = aliveOf(s, 'wolf');
    if (wolves.every((w) => s.pending.wolves[w.userId])) {
      s.pending.killTarget = wolfTargetOf(s, rng);
      effects.push(...witchPrompt(s));
    }
  } else if (me.role === 'seer') {
    // 一夜只能查一次：已经查过就不再给新结果（否则一夜能查遍全场，破坏玩法，2026-09-29 审查 P1）
    if (s.pending.seer) {
      const prev = s.roles.find((r) => r.userId === s.pending.seer);
      return canAck
        ? {
          state: s,
          effects: [{ type: 'private', userId: uid, text: `【狼人杀】今晚已经查过 ${prev ? `${idxOf(s, prev)} 号` : '人'}了，一夜只能查一次，天亮再查。` }]
        }
        : { state: s, effects: [], consume: true };
    }
    s.pending.seer = target.userId;
    // 查验结果不受回执配额约束（玩法信息必须送达；上面已经保证一夜只有一次）
    effects.push({ type: 'private', userId: uid, text: `🔮 查验结果：${idxOf(s, target)} 号 ${target.name} 是「${target.role === 'wolf' ? '狼人' : '好人'}」。` });
  }
  // 收齐就立刻结算夜晚（不干等 90 秒）
  if (nightReady(s)) {
    const out = resolveNight(s, rng, now);
    return { state: out.state, effects: [...effects, ...out.effects] };
  }
  return { state: s, effects, consume: !canAck && effects.length === 0 };
}

export function onTick(state, { now = 0, rng = Math.random } = {}) {
  if (state.phase === 'ended') return { state, effects: [] };
  const started = Number(state.phaseStartedAt) || now;
  // 每个阶段各自的窗口：夜间行动/投票用 roundSeconds；**白天讨论用固定值 discussSeconds**
  const windowSec = state.phase === 'day'
    ? (Number(state.discussSeconds) || DAY_DISCUSS_SECONDS)
    : (Number(state.roundSeconds) || meta.roundSeconds || 90);
  // 白天讨论快到时提前喊一嗓子：真人群里经常"谁也不想先开口"干等到点，
  // 这句不花钱（引擎自己发）、每天只发一次，discussSeconds 太短（<60 秒）就不插嘴
  if (state.phase === 'day' && !state.dayWarned && windowSec >= 60) {
    const leftMs = windowSec * 1000 - (now - started);
    if (leftMs > 0 && leftMs <= 30 * 1000) {
      const s = JSON.parse(JSON.stringify(state));
      s.dayWarned = true;
      return {
        state: s,
        effects: [{ type: 'public', text: '⏳ 还有约 30 秒开始投票（想说什么抓紧，也可以直接发「投 3」带票）。' }]
      };
    }
  }
  if (now - started < windowSec * 1000) return { state, effects: [] };

  if (state.phase === 'night') {
    // 到点用已收到的行动结算（没交的当夜空过）
    return resolveNight({ ...state, phaseStartedAt: now }, rng, now);
  }
  if (state.phase === 'day') {
    // 白天固定时长到点：不等谁"接上"，直接进投票阶段。**早票要留着**——但不能凭一票就结算
    // （其他人还没投票窗口；2026-09-29 审查 P2）。全员都投过了才立刻结算。
    const s = JSON.parse(JSON.stringify(state));
    const aliveIds = aliveList(s).map((r) => r.userId);
    if (aliveIds.length && aliveIds.every((uid) => s.votes?.[uid])) return tally(s, now);
    s.phase = 'vote';
    s.votes = s.votes && typeof s.votes === 'object' ? s.votes : {};
    s.phaseStartedAt = now;
    const secs = Number(s.discussSeconds) || DAY_DISCUSS_SECONDS;
    return { state: s, effects: [{ type: 'public', text: `讨论 ${secs} 秒到，开始投票：发「投 3」或「投 @他」都行。` }] };
  }
  if (state.phase === 'vote') return tally(state, now);
  return { state, effects: [] };
}

export function summaryForModel(state) {
  const list = aliveList(state).map((r) => `${idxOf(state, r)}号${r.name}`).join('、');
  const head = state.phase === 'night' ? `夜晚第 ${state.night} 夜（行动收集中）`
    : (state.phase === 'day'
      ? `第 ${state.night} 天讨论中（已发言 ${(state.spoken || []).length}/${aliveList(state).length} 人，已投票 ${Object.keys(state.votes || {}).length} 票，想开投 ${(state.readyVote || []).length} 人——过半即开）`
      : `第 ${state.night} 天投票中（已投 ${Object.keys(state.votes || {}).length} 票）`);
  const last = (state.nightLog || []).at(-1);
  const deadNums = last ? (Array.isArray(last.dead) ? last.dead : (last.died ? [last.died] : [])) : [];
  const dawn = last ? (deadNums.length ? `昨夜 ${deadNums.join('、')} 号出局` : '昨夜平安') : '';
  return `狼人杀进行中：${head}；存活 ${aliveList(state).length}/${state.roles.length} 人 —— ${list}${dawn ? `；${dawn}` : ''}。`
    + '身份、夜晚行动与查验结果都只走私聊，你只知道上面这些。';
}

export function hostBrief(state) {
  if (state.phase === 'night') {
    return '现在是夜晚：群里可以正常闲聊，但别催行动内容（行动走私聊），也别猜谁的身份；'
      + '有人嘴上说"刀谁/查谁"就当玩笑接过去，别追问、别当真。';
  }
  if (state.phase === 'day') {
    return '白天讨论中：谁想说就说，别催"轮到谁"、别按顺序点人（真人群不按点名），别替人报身份、别引导投谁，'
      + '按号码称呼（"3 号"）；有人说"投吧/直接投"就是想过票了，过半会自动开投，你不用替他们数；'
      + '没参加这局的人发言也正常回应，但别把他们的"投 X"当成有效票（只有在册玩家的票算数）。'
      + '已经出局的人在群里说话按"遗言/围观"处理：可以正常接话，但别把他的"投 X"当票、别顺着他说的身份或怀疑往下推、'
      + '也别替他确认或否认身份（他自己报身份也只当他在诈，别接这个话）。';
  }
  return '投票中：只报票数进度，不站队、不评价谁可疑；没参加的人与已出局的人投的票都不算，被问到就说明一下。';
}
