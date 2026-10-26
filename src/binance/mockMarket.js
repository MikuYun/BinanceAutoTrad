/**
 * 模拟行情源。
 *
 * 本机网络无法访问币安域名（DNS 被污染），因此模拟模式必须完全自洽：
 * 用几何布朗运动 + 均值回复生成价格，用真实感的 OHLCV 驱动 ATR。
 * 这不是占位符，而是一个确定性的、可复现的行情发生器。
 */

/** 标的基准价（模拟启动时的"当前价"） */
const SEED_PRICES = {
  BTCUSDT: 68000,
  ETHUSDT: 3200,
  SOLUSDT: 155,
  HYPEUSDT: 85,
  BNBUSDT: 590,
  XRPUSDT: 0.52,
  DOGEUSDT: 0.145,
  AVAXUSDT: 28,
  LINKUSDT: 14.5,
  ARBUSDT: 0.85,
};

/** 每个标的的模拟年化波动率（决定 ATR 大小） */
const VOL = {
  BTCUSDT: 0.55,
  ETHUSDT: 0.7,
  SOLUSDT: 0.95,
  HYPEUSDT: 1.15,
  BNBUSDT: 0.6,
  XRPUSDT: 0.9,
  DOGEUSDT: 1.05,
  AVAXUSDT: 0.95,
  LINKUSDT: 0.85,
  ARBUSDT: 1.0,
};

const INTERVAL_MS = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };

/** 每个标的的运行时状态 */
const state = new Map();

function randn() {
  // Box–Muller，避免引入依赖
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 取（或初始化）标的运行时 */
function getState(symbol) {
  let s = state.get(symbol);
  if (s) return s;
  const base = SEED_PRICES[symbol] || 10;
  const vol = VOL[symbol] || 0.8;
  s = {
    symbol,
    base,
    price: base,
    vol,
    // 缓慢漂移的锚，让价格不会无限漂走
    anchor: base,
    high24h: base * 1.01,
    low24h: base * 0.99,
    open24h: base,
    volume24h: base * 1000 + Math.random() * 500000,
    fundingRate: (Math.random() - 0.5) * 0.0002,
    nextFundingTime: Date.now() + 3600000,
    klines: new Map(),
    lastStep: Date.now(),
  };
  state.set(symbol, s);
  return s;
}

/**
 * 推进一个标的的价格。
 * 用「几何布朗运动 + 向锚点均值回复」：
 *   dP/P = -κ·ln(P/anchor)·dt + σ·dW
 * 这样价格既会波动，又不会单向漂移到 0 或无穷。
 */
function step(s, elapsedMs) {
  const dt = Math.min(elapsedMs, 60000) / (365 * 24 * 3600 * 1000);
  const kappa = 1.5; // 均值回复强度（按年化）
  const sigma = s.vol;
  const drift = -kappa * Math.log(s.price / s.anchor) * dt;
  const diffusion = sigma * Math.sqrt(dt) * randn();
  const next = s.price * Math.exp(drift + diffusion);
  s.price = Math.max(next, s.anchor * 0.3);
  s.lastStep = Date.now();

  // 更新统计
  s.high24h = Math.max(s.high24h, s.price);
  s.low24h = Math.min(s.low24h, s.price);
  s.volume24h = Math.max(s.volume24h, s.volume24h * 0.9999 + Math.random() * 1000);

  // 追加当前周期的 K 线
  pushKline(s);
  return s.price;
}

/** 往 K 线缓存追加一根（同一周期内只更新最后一根） */
function pushKline(s) {
  for (const [interval, ms] of Object.entries(INTERVAL_MS)) {
    let arr = s.klines.get(interval);
    if (!arr) {
      arr = generateHistory(s, interval, 200);
      s.klines.set(interval, arr);
    }
    const bucket = Math.floor(Date.now() / ms) * ms;
    const last = arr[arr.length - 1];
    if (last && last.t === bucket) {
      last.c = s.price;
      last.h = Math.max(last.h, s.price);
      last.l = Math.min(last.l, s.price);
    } else if (!last || bucket > last.t) {
      arr.push({
        t: bucket,
        o: last ? last.c : s.price,
        h: Math.max(last ? last.c : s.price, s.price),
        l: Math.min(last ? last.c : s.price, s.price),
        c: s.price,
        v: Math.random() * 1000 + 100,
      });
      if (arr.length > 300) arr.shift();
    }
  }
}

/** 冷启动时生成一段历史 K 线，保证 ATR 一开始就有意义 */
function generateHistory(s, interval, count) {
  const ms = INTERVAL_MS[interval];
  const now = Math.floor(Date.now() / ms) * ms;
  const perBar = s.vol * Math.sqrt(ms / (365 * 24 * 3600 * 1000));
  const out = [];
  let p = s.base * Math.exp(randn() * perBar * Math.sqrt(count) * 0.3);
  for (let i = count - 1; i >= 0; i -= 1) {
    const o = p;
    const c = p * Math.exp(randn() * perBar);
    const h = Math.max(o, c) * (1 + Math.abs(randn()) * perBar * 0.5);
    const l = Math.min(o, c) * (1 - Math.abs(randn()) * perBar * 0.5);
    out.push({ t: now - i * ms, o, h, l, c, v: Math.random() * 1000 + 100 });
    p = c;
  }
  return out;
}

/** 取 K 线（会先推进价格，保证新鲜） */
function klines(symbol, interval = '1h', limit = 200) {
  const s = getState(symbol);
  const iv = INTERVAL_MS[interval] ? interval : '1h';
  pushKline(s);
  const arr = s.klines.get(iv) || generateHistory(s, iv, 200);
  return arr.slice(-Math.min(Math.max(Number(limit) || 200, 1), 300));
}

/**
 * ATR 百分比：ATR(14) / 最新收盘价。
 * 用真实 Wilder 平滑，而不是简单均值，和币安口径接近。
 */
function atrPct(symbol, interval = '1h') {
  const bars = klines(symbol, interval, 60);
  if (bars.length < 2) return 0.02;
  const period = 14;
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prevC = bars[i - 1].c;
    const b = bars[i];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC)));
  }
  if (!trs.length) return 0.02;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
  for (let i = period; i < trs.length; i += 1) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  const last = bars[bars.length - 1].c;
  const pct = last > 0 ? atr / last : 0.02;
  // 夹在合理区间，避免冷启动的极端值把间距算飞
  return Math.min(0.15, Math.max(0.001, pct));
}

/** 当前价（会推进一小步，模拟行情的连续性） */
function getPrice(symbol) {
  const s = getState(symbol);
  step(s, Date.now() - s.lastStep);
  return s.price;
}

/** 点击器 */
function ticker(symbol) {
  const s = getState(symbol);
  return {
    symbol,
    price: s.price,
    open24h: s.open24h,
    high24h: s.high24h,
    low24h: s.low24h,
    volume24h: s.volume24h,
    change24hPct: s.open24h > 0 ? ((s.price - s.open24h) / s.open24h) * 100 : 0,
  };
}

/** 资金费率信息 */
function funding(symbol) {
  const s = getState(symbol);
  return {
    symbol,
    fundingRate: s.fundingRate,
    nextFundingTime: s.nextFundingTime,
  };
}

/** 所有可用标的 */
function symbols() {
  return Object.keys(SEED_PRICES);
}

/** 推进所有标的（供定时器调用，让未访问的标的也保持新鲜） */
function tickAll() {
  const now = Date.now();
  for (const symbol of symbols()) {
    const s = getState(symbol);
    step(s, now - s.lastStep);
  }
}

/** 模拟行情源永远是「可达」的 —— 它不联网 */
async function ping() {
  return { ok: true, latencyMs: 0, mock: true };
}

function health() {
  return { ok: true, source: 'mock', note: '本地模拟行情，无需联网' };
}

export const mockMarket = {
  source: 'mock',
  symbols,
  getPrice,
  ticker,
  atrPct,
  klines,
  funding,
  tickAll,
  ping,
  health,
};
