/** guard.js — 请求指标 + 预测告警核心（带宽/调用量爆炸检测）。
 *
 * 数据面（createGuard）：60s 滚动桶记录请求数、入/出字节、按路由计数；
 * 只有聚合数字、无任何业务数据，经 GET /api/v1/meta/guard 暴露给看门狗。
 *
 * 预测面（detect）：对请求速率做 EWMA 基线外推——当前速率超过绝对阈值
 * （maxRpm / maxBps）、相对基线突增（spikeMult 倍）、或单路由洪峰
 * （maxRouteRpm，防快照接口被 9 worker 式并发打爆）即告警。
 */

export function createGuard({ windowMs = 60_000, keep = 6 } = {}) {
  const buckets = new Map();
  let clientErrors = 0; // 浏览器端上报的运行时错误累计（白屏/资源 404 探针）
  const at = (t = Date.now()) => Math.floor(t / windowMs) * windowMs;
  const prune = (t = Date.now()) => {
    const cutoff = at(t) - (keep - 1) * windowMs;
    for (const k of buckets.keys()) if (k < cutoff) buckets.delete(k);
  };

  return {
    /** 浏览器端错误上报计数（POST /api/v1/meta/client-error 调用）。 */
    clientError() { clientErrors += 1; },

    /** 每个请求进来调一次；同时包一层 res.end 统计出站字节（近似，流式响应记 0）。 */
    record(req, res) {
      const ts = at();
      let b = buckets.get(ts);
      if (!b) { b = { req: 0, bytes_in: 0, bytes_out: 0, by_route: {} }; buckets.set(ts, b); }
      b.req += 1;
      const cl = Number(req.headers['content-length'] || 0);
      if (cl > 0) b.bytes_in += cl;
      let path;
      try { path = new URL(req.url || '/', 'http://x').pathname; } catch { path = '/'; }
      const route = `${req.method} ${path}`;
      b.by_route[route] = (b.by_route[route] || 0) + 1;
      const origEnd = res.end.bind(res);
      res.end = (chunk, ...rest) => {
        if (chunk) b.bytes_out += typeof chunk === 'string' ? Buffer.byteLength(chunk) : Number(chunk?.length) || 0;
        return origEnd(chunk, ...rest);
      };
      prune();
    },

    /** 快照：当前 60s 桶的聚合 + 最近 retained_min 分钟历史桶。 */
    snapshot(t = Date.now()) {
      prune(t);
      const cur = at(t);
      const curB = buckets.get(cur) || { req: 0, bytes_in: 0, bytes_out: 0, by_route: {} };
      const history = [...buckets.entries()].sort((a, b2) => a[0] - b2[0])
        .map(([ts, v]) => ({ ts, ...v }));
      return {
        now: new Date(t).toISOString(),
        window_s: windowMs / 1000,
        retained_min: keep,
        client_errors_total: clientErrors,
        per_minute: {
          total: curB.req,
          bytes_in: curB.bytes_in,
          bytes_out: curB.bytes_out,
          by_route: curB.by_route,
        },
        history,
      };
    },
  };
}

/** 预测检测（纯函数）。prevBaseline 为上一轮 detect 返回的 baseline（null=冷启动，只建立基线不告警）。
 * opts: { maxRpm=600, maxBps=5MiB/s, spikeMult=3, maxRouteRpm=240, ewmaAlpha=0.3 }
 * 返回 { alerted, alerts[], baseline, rpm, bps }。 */
export function detect(snap, prevBaseline = null, opts = {}) {
  const maxRpm = opts.maxRpm ?? 600;
  const maxBps = opts.maxBps ?? 5 * 1024 * 1024;
  const spikeMult = opts.spikeMult ?? 3;
  const maxRouteRpm = opts.maxRouteRpm ?? 240;
  const alpha = opts.ewmaAlpha ?? 0.3;

  const rpm = snap?.per_minute?.total || 0;
  const bytes = (snap?.per_minute?.bytes_in || 0) + (snap?.per_minute?.bytes_out || 0);
  const bps = bytes / Math.max(1, snap?.window_s || 60);
  const routeRpm = snap?.per_minute?.by_route || {};

  const baseline = prevBaseline
    ? { rpm: alpha * rpm + (1 - alpha) * prevBaseline.rpm,
        bps: alpha * bps + (1 - alpha) * prevBaseline.bps }
    : { rpm, bps };

  const alerts = [];
  if (!prevBaseline) return { alerted: false, alerts, baseline, rpm, bps, reason: 'warming' };
  if (rpm > maxRpm) alerts.push(`请求速率 ${rpm} rpm 超绝对阈值 ${maxRpm} rpm`);
  if (bps > maxBps) alerts.push(`带宽 ${(bps / 1024 / 1024).toFixed(2)} MB/s 超绝对阈值 ${(maxBps / 1024 / 1024).toFixed(2)} MB/s`);
  if (prevBaseline.rpm > 0 && rpm > Math.max(baseline.rpm, 1) * spikeMult && rpm > 30)
    alerts.push(`请求速率突增：${rpm} rpm ≈ 基线 ${baseline.rpm.toFixed(1)} rpm 的 ${(rpm / Math.max(baseline.rpm, 1)).toFixed(1)} 倍（> ${spikeMult}×）`);
  for (const [route, n] of Object.entries(routeRpm)) {
    if (n > maxRouteRpm) alerts.push(`路由洪峰 ${route}：${n} rpm 超 ${maxRouteRpm} rpm`);
  }
  return { alerted: alerts.length > 0, alerts, baseline, rpm, bps, reason: alerts.length ? 'alert' : 'ok' };
}
