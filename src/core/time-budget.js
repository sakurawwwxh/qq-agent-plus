// 单次操作的剩余时间预算（Issue #85）。
//
// 入站富化（解析引用、@昵称、合并转发）以前是一条串行 await 链：某个协议端请求
// 卡 30 秒，同群后续消息就跟着排队 30 秒。调用方现在把富化放到后台，但仍需要一个
// **总预算**兜底：到点必须按占位符放行，不能把消息永久卡在 deferred 状态。
//
// 语义：
// - run(promise, fallback)：最多等到总预算用完；超时、abort、promise 拒绝都返回 fallback；
// - 每个 run 共用同一个 deadline，前面的请求慢会压缩后面的预算，而不是各自重新计时；
// - signal 用于停服：abort 后所有仍在等待的调用立刻返回 fallback，后台任务能及时收尾。
export function createTimeBudget(ms, { signal = null } = {}) {
  const total = Math.max(1, Number(ms) || 1);
  const endsAt = Date.now() + total;
  const aborted = () => Boolean(signal?.aborted);

  function run(promise, fallback = null) {
    if (aborted()) return Promise.resolve(fallback);
    const remaining = endsAt - Date.now();
    if (remaining <= 0) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let onAbort = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      timer = setTimeout(() => finish(fallback), remaining);
      if (signal) {
        onAbort = () => finish(fallback);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve(promise).then(finish, () => finish(fallback));
    });
  }

  return {
    run,
    get expired() { return aborted() || Date.now() >= endsAt; },
    get remaining() { return Math.max(0, endsAt - Date.now()); }
  };
}
