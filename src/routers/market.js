/**
 * 行情路由。
 * GET /api/market/symbols | /api/market/klines | /api/market/overview | /api/market/health
 *
 * 价格来自币安实时行情（liveMarket 内存缓存，3 秒刷新一次）；
 * ATR 与 K 线走异步接口，拿真实 K 线计算，失败才降级模拟值。
 */
import { HttpError, requireAuth } from '../http.js';
import { getMarketFeed } from '../binance/index.js';
import { liveMarket } from '../binance/liveMarket.js';

export default function register(app) {
  app.get('/api/market/symbols', async (ctx) => {
    requireAuth(ctx);
    const feed = getMarketFeed();
    const list = feed.symbols() || [];
    // 价格与涨跌直接读内存缓存（3 秒刷新），秒回；
    // ATR 需要真实 K 线，只给前 N 个标的算（有 60 秒缓存），其余的由前端点开 K 线时再取。
    const ATR_LIMIT = 24;
    const rows = await Promise.all(
      list.map(async (symbol, i) => {
        const t = safe(() => feed.ticker(symbol), { price: 0, change24hPct: 0 });
        let atrPct = 0;
        if (i < ATR_LIMIT) {
          try {
            atrPct = typeof feed.atrPctAsync === 'function'
              ? await feed.atrPctAsync(symbol, '1h')
              : safe(() => feed.atrPct(symbol), 0.02);
          } catch {
            atrPct = 0;
          }
        }
        return {
          symbol,
          price: num(t.price),
          change24hPct: num(t.change24hPct),
          high24h: num(t.high24h),
          low24h: num(t.low24h),
          volume24h: num(t.volume24h),
          atrPct: num(atrPct * 100, 3),
          degraded: Boolean(t.degraded),
        };
      }),
    );
    return rows;
  });

  app.get('/api/market/klines', async (ctx) => {
    requireAuth(ctx);
    const symbol = String(ctx.query.symbol || '').toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) throw new HttpError(400, 'BAD_SYMBOL', '标的不合法');
    const interval = String(ctx.query.interval || '1h');
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 120, 1), 500);
    const feed = getMarketFeed();
    const bars = typeof feed.klinesAsync === 'function'
      ? await feed.klinesAsync(symbol, interval, limit)
      : feed.klines(symbol, interval, limit);
    return bars || [];
  });

  app.get('/api/market/overview', async (ctx) => {
    requireAuth(ctx);
    const symbol = String(ctx.query.symbol || 'BTCUSDT').toUpperCase();
    const feed = getMarketFeed();
    const t = safe(() => feed.ticker(symbol), {});
    let atrPct = 0.02;
    try {
      atrPct = typeof feed.atrPctAsync === 'function'
        ? await feed.atrPctAsync(symbol, '1h')
        : safe(() => feed.atrPct(symbol), 0.02);
    } catch {
      atrPct = 0.02;
    }
    const fund = safe(() => feed.funding && feed.funding(symbol), {});
    return {
      symbol,
      price: num(t.price),
      markPrice: num(t.price),
      atrPct: num(atrPct * 100, 3),
      fundingRate: num((fund && fund.fundingRate) || 0),
      nextFundingTime: (fund && fund.nextFundingTime) || null,
      high24h: num(t.high24h),
      low24h: num(t.low24h),
      volume24h: num(t.volume24h),
      change24hPct: num(t.change24hPct),
      source: feed.source || 'mock',
      degraded: Boolean(t.degraded),
    };
  });

  /** 连通性探测：不阻塞，8 秒超时，永远给结果 */
  app.get('/api/market/health', async (ctx) => {
    requireAuth(ctx);
    const feed = getMarketFeed();
    const isMock = (feed.source || 'mock') === 'mock';
    const h = typeof feed.health === 'function' ? feed.health() : { ok: null };
    if (isMock) {
      return {
        feedSource: 'mock',
        binanceReachable: null,
        latencyMs: 0,
        error: null,
        cache: h,
        note: '当前使用的是本地模拟行情（BINANCE_FEED=mock 强制指定），不联网。',
      };
    }
    const ping = typeof feed.ping === 'function' ? await feed.ping() : { ok: false, error: '未实现' };
    return {
      feedSource: feed.source || 'live',
      binanceReachable: Boolean(ping.ok),
      latencyMs: ping.latencyMs || 0,
      error: ping.ok ? null : ping.error || null,
      cache: h,
      note: ping.ok
        ? `已连接币安实时行情：缓存 ${h.quotes || 0} 个标的报价，标的列表 ${h.symbols || 0} 个。`
        : '当前无法直连币安域名，价格已降级为模拟值。可在能访问币安的机器/代理上部署以恢复实时行情。',
    };
  });
}

function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function num(v, d = 6) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
}

export { liveMarket };
