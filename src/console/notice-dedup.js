// 拍一拍/贴表情的事件去重（从 app.js 拆出，控制该文件的行数棘轮）。
//
// 这两类 notice 没有平台消息 id，messages 上的 UNIQUE(chat_key, mid) 对 NULL 不生效
// （SQLite 里 NULL 互不相等）。协议端重放/回声会让同一条 notice 落两行，并再唤醒一轮
// 模型。这里按事件签名在进程内去重：重放发生在同一次连接生命周期内；跨重启最坏只是
// 多一条记录，不会重复发言。
import crypto from 'node:crypto';

/** notice 没有稳定 id 时的签名兜底：同一组字段 = 同一条事件。 */
export function noticeStamp(event, fields) {
  if (event.time != null) return `t:${event.time}`;
  return `h:${crypto.createHash('sha1').update(JSON.stringify(fields)).digest('hex').slice(0, 16)}`;
}

export function pokeNoticeKey(chatKey, operatorId, targetId, event) {
  return `poke:${chatKey}:${operatorId}:${targetId}:`
    + noticeStamp(event, [operatorId, targetId, event.notice_type, event.sub_type]);
}

export function emojiNoticeKey(chatKey, operatorId, event) {
  return `emoji:${chatKey}:${operatorId}:${event.sub_type || 'add'}:`
    + `${event.message_id ?? ''}:${JSON.stringify(event.likes || [])}:`
    + noticeStamp(event, [operatorId, event.sub_type, event.message_id, event.likes]);
}

/** 有界 TTL 去重表：返回的 alreadySeen(key) 为 true 表示这条事件已处理过。 */
export function createNoticeDedup({ ttlMs = 10 * 60_000, max = 2000, now = Date.now } = {}) {
  // 注入点先落到本地常量：`ops.js scan --strict` 只认 const/let 声明，
  // 直接调用解构参数的默认值会被判成未定义调用（同一约定见 capabilities.js）。
  const nowFn = now;
  const seen = new Map();
  return {
    alreadySeen(key) {
      const at = nowFn();
      for (const [k, ts] of seen) {
        if (at - ts <= ttlMs) break;   // Map 按插入顺序，最早的在前
        seen.delete(k);
      }
      if (seen.has(key)) return true;
      if (seen.size >= max) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.set(key, at);
      return false;
    }
  };
}
