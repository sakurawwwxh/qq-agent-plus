// SSE 客户端的背压与半开连接处理（从 app.js 拆出，控制该文件的行数棘轮）。
//
// 页面留在后台、或者对端半开（拔网线、NAT 表项过期）时，res.write 只会往内核发送缓冲
// 里堆，没人读就无限涨；半开连接连 close 事件都不会有，于是永久挂在集合里，每次广播
// 都白写一遍、还拖着内存。两条兜底：① 写之前看 writableLength，积压超过上限就把这个
// 客户端丢掉；② 定期发注释行心跳（EventSource 会忽略），让"写不进去"尽早暴露。
export function createSseSender({ clients, log, backlogLimit }) {
  return function sseSend(res, line) {
    const closed = Boolean(res.writableEnded || res.destroyed);
    if (closed || Number(res.writableLength) > backlogLimit) {
      clients.delete(res);
      const why = closed ? '连接已关闭' : `积压超过 ${Math.round(backlogLimit / 1024)}KB`;
      log(`[console] 丢弃事件流客户端（${why}）`);
      try { res.end(); } catch { /* 已经断了 */ }
      // 只 end() 不够：keep-alive 下 socket 会一直留到 keepAliveTimeout 才关，
      // 对端既收不到 FIN 也不会重连，等于把"半开连接"换了个地方挂（2026-10-01 审查实测）。
      try { res.destroy?.(); } catch { /* 已经断了 */ }
      return;
    }
    try {
      res.write(line);
    } catch {
      clients.delete(res);
      // 与上面的积压分支同口径：只从集合里摘掉不够，半开 socket 会挂到内核超时。
      try { res.end(); } catch { /* 已经断了 */ }
      try { res.destroy?.(); } catch { /* 已经断了 */ }
    }
  };
}
