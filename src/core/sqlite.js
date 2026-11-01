// node:sqlite 的统一入口（改进方案 C5/#11）。
// 为什么存在：全仓 7 处直接 import 'node:sqlite'，缺内建模块时在加载期抛裸栈；
// PRAGMA 口径散在 2 处（store/identity 自己设），incident/relationship/asset-observer
// 三处漏设 busy_timeout —— 读写下碰撞时是偶发 SQLITE_BUSY，排查成本高。
//
// 实现要点（照抄会写出 bug）：探测**不能用顶层静态 import** —— 静态 import 在模块
// 加载期就抛栈，探测代码永远执行不到。这里用顶层 await import 包 try/catch，失败只记
// flag，openDatabase/backup 被调用时才抛人话错误；API 保持同步（8 个调用点全在同步
// 上下文，async 化会把整个存储层染遍）。同款写法见 deploy.sh 的 node_ready()。
let nodeSqlite = null;
let loadError = null;
try {
  nodeSqlite = await import('node:sqlite');
} catch (error) {
  loadError = error;
}

export function assertSqliteAvailable() {
  if (nodeSqlite) return;
  const reason = loadError?.message ?? loadError;
  throw new Error(
    '当前 Node 不支持 node:sqlite（需要 >= 22.19 且未禁用实验 API）。'
    + `加载失败原因：${reason ?? '未知'}。请升级 Node，或改用 deploy.sh 安装的 .runtime 运行时。`
  );
}

/**
 * 统一口径的打开 + PRAGMA：
 * - busy_timeout=5000（全连接）：incident/relationship/asset-observer 此前没有，读写下
 *   碰撞会偶发 SQLITE_BUSY —— 这是本适配层补上的唯一行为变化。
 * - foreign_keys=ON（写连接）：identity 库有外键约束且原本就开；其余库无约束，无影响。
 * - **不统一 journal_mode / synchronous**：store/identity 原本是 WAL+FULL（由各自建表 exec
 *   设置），其余库是默认 delete —— 若把 WAL 强加给其余库，会产生 -wal/-shm 伴生文件，
 *   而 manage.sh backup 只对 messages 做一致性快照、其余库是整目录直接拷贝，WAL 会让
 *   备份出现非一致快照（数据安全底线）。要给其余库上 WAL，必须先改 backup 链路，两件事
 *   不该捆绑（2026-09-30 审查修正，偏离方案 §3 #11 的"统一 WAL"，理由如上）。
 * - 只读连接：只设 busy_timeout（写类 PRAGMA 在只读句柄上无效或多余）
 */
export function openDatabase(file, { readOnly = false } = {}) {
  assertSqliteAvailable();
  let db;
  try {
    db = new nodeSqlite.DatabaseSync(file, readOnly ? { readOnly: true } : {});
  } catch (error) {
    // 只抛 "unable to open database file" 时运维看不出是哪个目录/什么权限（2026-10-31 审查 P2）：
    // 补上路径与可操作提示，并保留原始 error 作为 cause。
    const reason = String(error?.message ?? error);
    const wrapped = new Error(
      `打开 SQLite 失败：${file}（${reason}）。请确认目录存在、当前用户可写；只读模式还需文件存在。`
    );
    wrapped.code = error?.code || 'E_SQLITE_OPEN';
    wrapped.cause = error;
    throw wrapped;
  }
  try {
    if (readOnly) {
      db.exec('PRAGMA busy_timeout=5000;');
    } else {
      db.exec(`
        PRAGMA busy_timeout=5000;
        PRAGMA foreign_keys=ON;
      `);
    }
  } catch { /* 有意忽略：PRAGMA 失败不阻断打开（内存库/受限只读环境），建表与业务逻辑会兜底 */ }
  return db;
}

/** node:sqlite 的在线备份 API（manage.sh backup 用），走同一道可用性闸门。 */
export function backup(db, target) {
  assertSqliteAvailable();
  return nodeSqlite.backup(db, target);
}
