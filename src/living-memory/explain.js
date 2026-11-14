// 长期记忆召回解释：把 retrieval 分数和来源回合摘要整理成控制台可读的结构。
// 只读；不把来源会话/私聊内容送进群聊或模型提示词。
function asText(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parsePayload(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

/** 取 source.turnIds 对应的回合摘要（最多 4 个回合，每回合最多 6 行）。 */
export function sourceTurns(store, turnIds = []) {
  if (!store?.db?.prepare) return [];
  const ids = [...new Set((Array.isArray(turnIds) ? turnIds : []).map(String).filter(Boolean))].slice(0, 4);
  if (!ids.length) return [];
  const stmt = store.db.prepare('SELECT id, scope_key, session_id, payload_json, created_at FROM turns WHERE id=?');
  return ids.map((id) => {
    const row = stmt.get(id);
    if (!row) return null;
    const payload = parsePayload(row.payload_json);
    const lines = (Array.isArray(payload.lines) ? payload.lines : [])
      .slice(-6)
      .map((line) => ({
        role: asText(line?.role, 20),
        sender: asText(line?.senderName || line?.senderId, 80),
        text: asText(line?.text, 500),
        ts: Number(line?.ts) || 0
      }))
      .filter((line) => line.text);
    return { id: row.id, scopeKey: row.scope_key, sessionId: row.session_id, createdAt: row.created_at, lines };
  }).filter(Boolean);
}

/** 在 recall 结果上补来源回合；其余字段原样保留。 */
export function explainRecall(result, store) {
  if (!result || !Array.isArray(result.entries)) return result;
  return {
    ...result,
    entries: result.entries.map((entry) => ({
      ...entry,
      sourceTurns: sourceTurns(store, entry?.source?.turnIds || [])
    }))
  };
}
