/**
 * 实盘行情源：真正连币安 fapi 的实时行情。
 *
 * 设计要点：
 *   1. 同步接口（getPrice/ticker/klines/atrPct）只读内存缓存，绝不阻塞事件循环；
 *   2. 后台定时器（start()）用 /fapi/v1/ticker/price 一次拉全市场最新价刷新内存；
 *   3. 异步接口（*Async）直接联网取最新数据，供机器人决策使用；
 *   4. 任何失败都降级到 mock 并标记 degraded，永不抛未捕获异常。
 */
import * as rest from './rest.js';
import { mockMarket } from './mockMarket.js';

const CACHE_TTL = {
  atr: 60000,
  klines: 60000,
};

/** 全市场最新价刷新间隔 */
const PRICE_REFRESH_MS = 3000;
/** 24h 行情（涨跌幅/成交额/高低）刷新间隔 */
const TICKER_REFRESH_MS = 30000;
/** 标的列表刷新间隔 */
const SYMBOLS_REFRESH_MS = 300000;

/** 默认展示的标的（币安 USDT 永续常见品种），拉到真实列表后会被覆盖 */
const FALLBACK_SYMBOLS = [
  // 主流
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
  'ADAUSDT', 'TRXUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT',
  'BCHUSDT', 'ETCUSDT', 'XLMUSDT', 'HBARUSDT', 'SUIUSDT', 'APTUSDT',
  'ARBUSDT', 'OPUSDT', 'TONUSDT', 'NEARUSDT', 'ATOMUSDT', 'FILUSDT',
  'INJUSDT', 'SEIUSDT', 'TIAUSDT', 'RUNEUSDT', 'AAVEUSDT', 'UNIUSDT',
  // 热门 meme / 新叙事
  'HYPEUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', 'FLOKIUSDT', 'SHIBUSDT',
  'DOGSUSDT', 'PNUTUSDT', 'ACTUSDT', 'GOATUSDT', 'MOODENGUSDT', 'TRUMPUSDT',
  // AI / 大市值科技相关
  'TAOUSDT', 'FETUSDT', 'RENDERUSDT', 'WLDUSDT', 'ARKMUSDT', 'VIRTUALUSDT',
];

const cache = new Map();
const health = { ok: null, lastCheck: 0, lastError: null, checkedAt: 0, lastPriceAt: 0, symbols: 0 };

/** symbol -> { price, open24h, high24h, low24h, volume24h, change24hPct, at } */
const quotes = new Map();
let symbolList = [...FALLBACK_SYMBOLS];
let timer1 = null;
let timer2 = null;
let timer3 = null;
let started = false;

function cacheGet(key) {
  const rec = cache.get(key);
  if (!rec) return null;
  if (Date.now() - rec.at > rec.ttl) return null;
  return rec.value;
}

function cacheSet(key, value, ttl) {
  cache.set(key, { value, at: Date.now(), ttl });
  return value;
}

function noteError(err) {
  health.ok = false;
  health.lastError = (err && err.message) || String(err);
  health.checkedAt = Date.now();
  return err;
}

function noteOk() {
  health.ok = true;
  health.lastError = null;
  health.checkedAt = Date.now();
}

function ensureQuote(symbol) {
  let q = quotes.get(symbol);
  if (!q) {
    q = { price: 0, open24h: 0, high24h: 0, low24h: 0, volume24h: 0, change24hPct: 0, at: 0 };
    quotes.set(symbol, q);
  }
  return q;
}

/* ------------------------------------------------------------------ *
 * 后台刷新
 * ------------------------------------------------------------------ */

/** 拉全市场最新价（一次请求覆盖所有标的） */
async function refreshPrices() {
  const rows = await rest.tickerAllPrice();
  if (!Array.isArray(rows)) return;
  const now = Date.now();
  for (const row of rows) {
    const symbol = String(row.symbol || '');
    if (!symbol.endsWith('USDT')) continue;
    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const q = ensureQuote(symbol);
    q.price = price;
    q.at = now;
  }
  health.lastPriceAt = now;
  noteOk();
}

/** 拉全市场 24h 行情：涨跌幅、成交额、最高最低；顺带刷新标的列表 */
async function refreshTickers() {
  const rows = await rest.tickerAll24h();
  if (!Array.isArray(rows)) return;
  const now = Date.now();
  for (const row of rows) {
    const symbol = String(row.symbol || '');
    if (!symbol.endsWith('USDT')) continue;
    const price = Number(row.lastPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    const q = ensureQuote(symbol);
    if (!(q.price > 0)) q.price = price;
    q.open24h = Number(row.openPrice) || q.price;
    q.high24h = Number(row.highPrice) || q.price;
    q.low24h = Number(row.lowPrice) || q.price;
    q.volume24h = Number(row.quoteVolume) || 0;
    q.change24hPct = Number(row.priceChangePercent) || 0;
    q.at = q.at || now;
  }
  // 用这批真实成交额数据直接排标的，避免依赖上一轮回填的 quotes
  refreshSymbolList(rows);
  noteOk();
}

/** 刷新标的列表：按 24h 成交额排序取前 N 个 USDT 永续 */
function refreshSymbolList(rows) {
  if (!Array.isArray(rows)) return;
  const active = rows
    .filter((r) => String(r.symbol || '').endsWith('USDT') && Number(r.quoteVolume) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, 80)
    .map((r) => String(r.symbol));
  if (!active.length) return;
  // 用户实盘在做的 HYPEUSDT 必须常驻
  if (!active.includes('HYPEUSDT')) active.push('HYPEUSDT');
  symbolList = active;
  health.symbols = symbolList.length;
}

/** 后台跑一轮（不抛异常） */
async function loop(fn) {
  try {
    await fn();
  } catch (err) {
    noteError(err);
  }
}

/**
 * 启动后台刷新。幂等，多次调用只生效一次。
 * 由 server.js 在监听端口后调用。
 */
export function start() {
  if (started) return;
  started = true;
  const kick = () => {
    loop(refreshPrices);
    loop(refreshTickers).then(() => {
      // 首次拿到 24h 数据后立即修正标的列表
      const rows = Array.from(quotes.entries()).map(([symbol, q]) => ({ symbol, quoteVolume: q.volume24h }));
      refreshSymbolList(rows);
    });
  };
  kick();
  timer1 = setInterval(() => loop(refreshPrices), PRICE_REFRESH_MS);
  timer2 = setInterval(() => loop(refreshTickers), TICKER_REFRESH_MS);
  timer3 = setInterval(() => loop(refreshTickers), SYMBOLS_REFRESH_MS);
  for (const t of [timer1, timer2, timer3]) if (t && t.unref) t.unref();
}

export function stop() {
  for (const t of [timer1, timer2, timer3]) if (t) clearInterval(t);
  timer1 = timer2 = timer3 = null;
  started = false;
}

/** 手动触发一次全量刷新（异步） */
export async function refreshNow() {
  await loop(refreshPrices);
  await loop(refreshTickers);
}

/* ------------------------------------------------------------------ *
 * K 线与 ATR（走缓存，异步取）
 * ------------------------------------------------------------------ */

async function liveKlines(symbol, interval, limit) {
  const key = `k:${symbol}:${interval}:${limit}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const raw = await rest.klines(symbol, interval, limit);
  const bars = (raw || []).map((x) => ({
    t: Number(x[0]),
    o: Number(x[1]),
    h: Number(x[2]),
    l: Number(x[3]),
    c: Number(x[4]),
    v: Number(x[5]),
  }));
  cacheSet(key, bars, CACHE_TTL.klines);
  return bars;
}

/** 用 K 线算 ATR 百分比（Wilder 平滑） */
export function atrPctFromBars(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return 0.02;
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const pc = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
  }
  if (!trs.length) return 0.02;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
  for (let i = period; i < trs.length; i += 1) atr = (atr * (period - 1) + trs[i]) / period;
  const last = bars[bars.length - 1].c;
  const pct = last > 0 ? atr / last : 0.02;
  return Math.min(0.15, Math.max(0.001, pct));
}

async function liveAtrPct(symbol, interval = '1h') {
  const key = `atr:${symbol}:${interval}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  try {
    const bars = await liveKlines(symbol, interval, 60);
    if (!bars || bars.length < 2) throw new Error('K 线不足，无法计算 ATR');
    const pct = atrPctFromBars(bars);
    noteOk();
    return cacheSet(key, pct, CACHE_TTL.atr);
  } catch (err) {
    noteError(err);
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 对外接口（与 mockMarket 保持一致）
 * ------------------------------------------------------------------ */

export const liveMarket = {
  source: 'live',

  start,
  stop,
  refreshNow,

  /** 后台预热指定标的（兼容老接口） */
  async prime(symbols = []) {
    await loop(refreshPrices);
    const list = Array.isArray(symbols) && symbols.length ? symbols : symbolList;
    // 顺手把 ATR 也算好，避免首次决策用兜底值
    for (const symbol of list.slice(0, 8)) {
      try {
        await liveAtrPct(symbol, '1h');
      } catch {
        /* 单个失败不影响其他 */
      }
    }
  },

  /** 同步取价：只读内存，未命中才回退模拟价（保证永不返回 0） */
  getPrice(symbol) {
    const q = quotes.get(symbol);
    if (q && Number.isFinite(q.price) && q.price > 0) return q.price;
    return mockMarket.getPrice(symbol);
  },

  /** 是否已有真实报价 */
  hasQuote(symbol) {
    const q = quotes.get(symbol);
    return Boolean(q && q.price > 0 && q.at > 0);
  },

  ticker(symbol) {
    const q = quotes.get(symbol);
    if (q && q.price > 0) {
      const open = q.open24h || q.price;
      return {
        symbol,
        price: q.price,
        open24h: open,
        high24h: q.high24h || q.price,
        low24h: q.low24h || q.price,
        volume24h: q.volume24h || 0,
        change24hPct: Number.isFinite(q.change24hPct) && q.change24hPct !== 0
          ? q.change24hPct
          : (open > 0 ? ((q.price - open) / open) * 100 : 0),
        at: q.at,
        degraded: false,
      };
    }
    const m = mockMarket.ticker(symbol);
    return { ...m, degraded: true, source: 'mock' };
  },

  /** 同步 ATR：只读缓存，未命中用模拟值（机器人应优先用 atrPctAsync） */
  atrPct(symbol, interval = '1h') {
    const hit = cacheGet(`atr:${symbol}:${interval}`);
    if (hit !== null) return hit;
    return mockMarket.atrPct(symbol, interval);
  },

  async atrPctAsync(symbol, interval = '1h') {
    try {
      return await liveAtrPct(symbol, interval);
    } catch {
      return mockMarket.atrPct(symbol, interval);
    }
  },

  /** 同步 K 线：只读缓存，未命中用模拟值（机器人应优先用 klinesAsync） */
  klines(symbol, interval = '1h', limit = 200) {
    const hit = cacheGet(`k:${symbol}:${interval}:${limit}`);
    if (hit) return hit;
    return mockMarket.klines(symbol, interval, limit);
  },

  async klinesAsync(symbol, interval = '1h', limit = 200) {
    try {
      return await liveKlines(symbol, interval, limit);
    } catch (err) {
      noteError(err);
      return mockMarket.klines(symbol, interval, limit);
    }
  },

  funding(symbol) {
    return mockMarket.funding(symbol);
  },

  symbols() {
    return [...symbolList];
  },

  async ping() {
    const t0 = Date.now();
    try {
      await rest.ping();
      noteOk();
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      noteError(err);
      return { ok: false, latencyMs: Date.now() - t0, error: (err && err.message) || String(err) };
    }
  },

  health() {
    return { ...health, quotes: quotes.size, symbols: symbolList.length, started };
  },
};
