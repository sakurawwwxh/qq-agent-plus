# 出站副作用账本（effect ledger）

状态：**第一阶段已实现**（2026-10-31）：群日报、提醒、群游戏终局已接入；
直连协议端的写工具只登记不拦截；插件写操作的退款 journal 与 `auto-update.json`
跨进程锁仍按原计划留待后续。实现见 `src/core/effects.js` 与 `messages.sqlite` 的 `effects` 表。

## 问题

所有"机器人对外做了一件事"的操作，最终都要回答同一个问题：**这次到底有没有生效？**
现在代码里没有统一答案，而是各自处理：

| 位置 | 现有机制 | 缺口 / 现状 |
| --- | --- | --- |
| `SendQueue`（文本/贴纸/语音/表情/戳/文件/相册） | outbox `sending/unknown` + `hasUncertainEffects` | 覆盖面最全，继续作为逐条消息的事实来源 |
| 直连协议端的写操作（贴表情/签名/状态/备注/签到/待办/头像/资料/群名片/禁言/踢人/撤回/设管理员/相册点赞与评论） | 无 | **已接入账本（只登记）**：每次调用一行；协议端明确拒绝记 failed，超时/连接重置记 unknown；不拦截正常调用 |
| 群游戏终局播报 / 群日报 | 发送前写标记 | **已接入**：幂等键 + unknown 不重发；日报按"归属日"去重（修跨午夜） |
| 提醒（reminders） | `hasSelfSince(chatKey, dispatchedAt)` 近似判断 | **已接入**：崩溃/重启不重复播报；"回了别的消息也算已播报"的近似语义保留 |
| 插件写操作 | 调用前消费配额，内存退款收据 | 已有 `recordPluginWrite` 持久审计（含 unknown）；退款收据跨崩溃仍按保守策略不退，留待后续 |
| `auto-update.json` | 整文件读改写 | 需要的是跨进程文件锁，不属于本账本范围，单独做 |

结论：**不是某一处写错了，是"副作用"这个概念没有单一归属。** 继续点状修，第七个还会来。

## 提议

一个极薄的持久化账本，所有出站副作用在**执行前**登记、**结果确定后**结算：

```text
effects(id TEXT PRIMARY KEY, kind, chat_key, idem_key, state, payload_json, created_at, settled_at)
state: planned | sent | unknown | failed | skipped
唯一索引: (kind, idem_key)
```

接口（伪代码）：

```js
const effect = effects.begin({
  kind: 'send',              // send | react | signature | todo | plugin-write | reminder | digest
  chatKey,
  idemKey,                   // 调用方给：消息 mid、提醒 id、日报日期 + 群号、插件操作哈希
  payload: { ... }           // 仅排障需要的最小字段，正文按现有口径脱敏/截断
});
try {
  const result = await doIt();
  effects.settle(effect, 'sent', { messageId: result?.message_id });
} catch (error) {
  // 关键：判得出"确定没发出去"才允许重试；判不出就是 unknown，永不自动重试
  effects.settle(effect, isCertainlyNotSent(error) ? 'failed' : 'unknown');
  throw error;
}
```

规则：

1. **unknown 不自动重试**。已有的两条保护（发送队列、提醒的 4 次上限）继续保留；
   新接入方默认继承"未知即停"，要重试必须显式声明。
2. **幂等键由业务给**，账本只做唯一约束。重复 `begin` 同一 `(kind, idemKey)` 时返回已有记录，
   调用方据此跳过（真正的去重发生在业务层，账本只提供证据）。
3. **启动时（成功监听后）扫描全部 `planned` → 标记 `unknown`**（进程刚起，不存在本进程的在途动作），不自动退款、不自动补发
   —— 与 `kill -9` 落在消费与结算之间的现有口径一致。`unknown` 在 `/api/status`、
   总览页、`ops doctor` 与 `ops effects list` 可见（不写 incident-pilot 异常台账）。
4. 结算后按保留期清理（`sent/failed/skipped` 默认 90 天）；`unknown` 永久保留，直到人工改判。
5. 写审计与账本分离：审计回答"谁改了什么"，账本回答"这件事成没成"。

## 已落地实现（2026-10-31）

- 表：`messages.sqlite` 的 `effects`（与 outbox 同库，同一备份与保留期）。
  `(kind, idem_key)` 唯一；`detail` 只放排障最小字段（日期、目标、结果码）。
- 模块：`src/core/effects.js` 的 `EffectLedger`，接口 `begin / settle / get / resolve /
  markStalePlanned / stats`（另有 `prune` 给每日保留期）。
- 状态机：`planned → sent | failed | unknown | skipped`；`unknown` 终态，永不自动重试；
  `failed` 允许重新 begin（能证明没做成的失败可以再试）。
- 人工核对出口：`resolve(id, 'sent'|'failed')` 只允许把 `unknown` 改判，并写入
  `resolvedAt/resolvedBy=manual`。群日报的「立即试跑一次」走 `runOnce({forceUnknown:true})`，
  先清理同 effect id 的 outbox 未知行、再 resolve 成 failed 后重新执行；
  其余类型用 `node src/ops.js effects list` 找到 id，再
  `node src/ops.js effects resolve <id> --sent|--failed --confirm`。
  控制台的「未知写入 → 已发送」核对也会在整条 run 核对完后同步账本；
  `ops effects resolve` 同样会按 `outbox.run_id = effect id` 核对未知发送、释放 held
  （2026-10-31 全量审查 P2：此前只改账本，会话会一直卡在待核对）。
- 启动时把**全部**停在 `planned` 的记录转成 `unknown`：控制台在**成功监听端口之后**清扫
  （`sweep:false` 构造；未抢到端口/绑定失败不清扫，避免误伤另一个正在运行的实例），
  此刻不存在本进程的在途动作，不能等 15 分钟 TTL（否则重启落在发送窗口内会让日报/游戏播报
  被当成 in-flight 并跳过当天；2026-10-31 全量审查 P2）。
  并把 `unknown` 暴露在 `/api/status`、总览页与 `ops doctor`（不写 incident-pilot 异常台账）。
- 已接入：
  - 群日报 `digest:<chatKey>:<归属日>`：同一天同一群只发一次；跨午夜按开始那天归属。
  - 提醒 `reminder:<提醒id>:<occurrenceId>`（occurrenceId 由 `ensureOccurrenceId` 生成，
  顺延/短重试不改，周期项 re-arm 时换新）：崩溃后不重复播报；未知即停，周期项只跳本期。
  - 群游戏终局 `game:<chatKey>:<局id>`：一局一条；unknown 停止重试。
  - 直连协议端的写操作（贴表情、签名、在线状态、好友/群备注、群签到、群待办、头像、资料、
    群名片、禁言、踢人、撤回、设管理员、群相册点赞/评论）
    `direct:<动作>:<会话>:<随机>`：只登记，不参与去重；协议端明确拒绝的记 failed，
    超时/连接重置才记 unknown。
- 可观测：`/api/status.effects`（状态计数 + 近 24h unknown）、总览页"运行体检"里单独一行
  待核对提示、`ops doctor` 的 `effects.json` 与终端摘要。
- 保留期：`sent/failed/skipped` 默认 90 天清理；**`unknown` 永久保留**（等人工核对），
  量级是"每次结果未知一行"，不会随日常运行增长。`start()` 成功监听后也会清一次，
  避免"每天重启导致每日任务永远等不到第二个自然日"。
- 测试：`test/effect-ledger.test.mjs` 覆盖状态机/幂等/清扫/保留期/resolve 审计/跨进程崩溃；
  群日报（含清理真实 outbox 未知行后的强制重试）、提醒（含周期项）、群游戏（含同型两局）
  各有"unknown 不重发"的行为用例。直连写工具的分类目前靠共享 `classifyTransportFailure`，
  尚无逐工具的故障注入用例。

## 迁移顺序（每步独立可回滚）

1. ~~群日报试点~~（已完成）：按归属日去重，unknown 不重发。
2. ~~群游戏终局播报~~（已完成）：一局一条，unknown 停止重试。
3. ~~提醒接入~~（已完成，部分语义保留）：崩溃后不重复播报；"本轮有没有发送"仍是近似判据，
   要精确到"这条提醒的正文真的发出去了"需要让 `send_message` 携带 reminder id，留待后续。
4. ~~直连协议端的写工具~~（已完成"只登记"）：观察一段时间 unknown 比例后再决定是否禁止自动重试。
5. 插件写操作：把内存退款收据换成账本记录（消费/结算各一行），解决宿主硬崩错账。
6. `auto-update.json`：不并入账本；它需要的是跨进程文件锁（mkdir 型 `.lock`），
   与副作用无关，单独做。

## 非目标

- 不做分布式/多实例：本项目的部署形态是单机单进程 + 旁路定时器。
- 不替代 `SendQueue` 的 outbox：第一阶段账本只做"证据与决策"，发送仍走队列。
- 不记录消息正文：`payload` 只放 mid/提醒 id/目标/结果码，正文按现有审计口径截断脱敏。

## 验收

- 已接入的业务动作（日报/提醒/群游戏）都有一条"结果未知不重发"的行为用例；
  账本层有一条真实跨进程崩溃用例（begin 后进程退出 → 重启清扫为 unknown）。
  直连写工具目前只验证了分类函数，尚未逐工具注入。
- `/api/status.effects` / 总览页 / `ops doctor` 能看到状态计数；
  `unknown` 在总览里单独提示（不混进巡检失败项）。
- 账本表增长与运行台账同量级（每次动作一行），保留期清理后不成为新的无界文件。

## 为什么先写文档

这一步会动 `SendQueue`、`orchestrator`、`tools-core`、插件宿主四条主链路，
风险和收益都不小。先把"未知即停"的语义、幂等键归属和试点顺序定下来，
再按上面的顺序逐步接入，比一次性重构安全得多。
