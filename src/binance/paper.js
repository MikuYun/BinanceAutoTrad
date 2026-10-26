/**
 * 模拟交易所（纸面撮合）。
 *
 * 只负责「账户账本 + 下单/平仓」，不判定策略，不读参数。
 * 状态存在 robots.paper_json 里，每次 tick 由 engine 读写。
 *
 * 双向持仓：同一标的多空可同时存在（对应币安 Hedge Mode）。
 */
import { PAPER } from '../config.js';

const FEE = PAPER.feeRate;
const SLIP = PAPER.slippagePct;

/** 新建账本 */
export function createBook(initialCapital) {
  const cap = Number.isFinite(Number(initialCapital)) && Number(initialCapital) > 0
    ? Number(initialCapital)
    : 100;
  return {
    initialCapital: cap,
    walletBalance: cap,
    realizedPnl: 0,
    feePaid: 0,
    positions: {}, // { long: [leg], short: [leg] } 由调用方按需建
    lastPrice: 0,
    updatedAt: Date.now(),
  };
}

/** 确保方向数组存在 */
function sideArr(book, side) {
  if (!book.positions) book.positions = {};
  if (!Array.isArray(book.positions[side])) book.positions[side] = [];
  return book.positions[side];
}

/**
 * 某一方向所有腿的汇总。
 * @returns {{qty:number, notional:number, avgEntry:number, unrealizedPnl:number, margin:number}}
 */
export function summarizeSide(book, side, markPrice) {
  const legs = sideArr(book, side);
  let qty = 0;
  let notional = 0;
  let margin = 0;
  for (const leg of legs) {
    qty += Number(leg.qty) || 0;
    notional += (Number(leg.qty) || 0) * (Number(leg.entryPrice) || 0);
    margin += Number(leg.margin) || 0;
  }
  const avgEntry = qty > 0 ? notional / qty : 0;
  const mark = Number(markPrice) || 0;
  let unrealizedPnl = 0;
  if (qty > 0 && mark > 0) {
    unrealizedPnl = side === 'long' ? (mark - avgEntry) * qty : (avgEntry - mark) * qty;
  }
  return { qty, notional, avgEntry, unrealizedPnl, margin, legs: legs.length };
}

/**
 * 账户权益 = 钱包余额 + 两方向未实现盈亏。
 */
export function equityOf(book, markPrice) {
  const l = summarizeSide(book, 'long', markPrice);
  const s = summarizeSide(book, 'short', markPrice);
  return Number(book.walletBalance || 0) + l.unrealizedPnl + s.unrealizedPnl;
}

/**
 * 开仓（模拟撮合，立即成交）。
 *
 * @param {object} book
 * @param {object} order {side:'long'|'short', notional, price, leverage, layer, reason}
 * @returns {{ok:boolean, order?:object, error?:string, book:object}}
 */
export function openPosition(book, order) {
  const { side, notional, price, leverage = 20 } = order;
  const mark = Number(price);
  if (!Number.isFinite(mark) || mark <= 0) return { ok: false, error: '价格无效', book };
  const n = Number(notional);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: '名义金额无效', book };

  const margin = n / Math.max(1, Number(leverage) || 20);
  if (margin > Number(book.walletBalance || 0) + 1e-9) {
    return { ok: false, error: `可用保证金不足：需要 ${margin.toFixed(4)}U，可用 ${Number(book.walletBalance).toFixed(4)}U`, book };
  }

  const fillPrice = side === 'long' ? mark * (1 + SLIP) : mark * (1 - SLIP);
  const qty = n / fillPrice;
  const fee = n * FEE;

  book.walletBalance = Number(book.walletBalance) - fee;
  book.feePaid = Number(book.feePaid || 0) + fee;
  book.lastPrice = mark;
  book.updatedAt = Date.now();

  const leg = {
    id: `${side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    qty,
    entryPrice: fillPrice,
    margin,
    notional: n,
    leverage,
    layer: order.layer || 1,
    reason: order.reason || 'open',
    openedAt: Date.now(),
  };
  sideArr(book, side).push(leg);

  return {
    ok: true,
    book,
    order: {
      side: side === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT',
      qty,
      price: fillPrice,
      notional: n,
      fee,
      margin,
      leg,
    },
  };
}

/**
 * 平掉某一方向的全部仓位（模拟）。
 * @returns {{ok:boolean, closed?:object[], error?:string, book:object}}
 */
export function closeSide(book, side, price, reason = 'tp') {
  const mark = Number(price);
  if (!Number.isFinite(mark) || mark <= 0) return { ok: false, error: '价格无效', book };
  const legs = sideArr(book, side);
  if (!legs.length) return { ok: true, closed: [], book };

  const fillPrice = side === 'long' ? mark * (1 - SLIP) : mark * (1 + SLIP);
  let pnl = 0;
  let fee = 0;
  let notional = 0;
  for (const leg of legs) {
    const q = Number(leg.qty) || 0;
    const entry = Number(leg.entryPrice) || 0;
    const legPnl = side === 'long' ? (fillPrice - entry) * q : (entry - fillPrice) * q;
    pnl += legPnl;
    notional += q * fillPrice;
    fee += q * fillPrice * FEE;
  }
  book.walletBalance = Number(book.walletBalance) + pnl - fee;
  book.realizedPnl = Number(book.realizedPnl || 0) + pnl;
  book.feePaid = Number(book.feePaid || 0) + fee;
  book.lastPrice = mark;
  book.updatedAt = Date.now();
  book.positions[side] = [];

  return {
    ok: true,
    book,
    closed: {
      side: side === 'long' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
      qty: notional / fillPrice,
      price: fillPrice,
      notional,
      pnl,
      fee,
      reason,
    },
  };
}

/**
 * 只平掉指定的几笔（逐笔止盈用）。legIds 为 openPosition 生成的 leg.id。
 * 未命中的仓位原样保留。
 */
export function closeLegs(book, side, price, legIds, reason = 'tp') {
  const mark = Number(price);
  if (!Number.isFinite(mark) || mark <= 0) return { ok: false, error: '价格无效', book };
  const ids = new Set(Array.isArray(legIds) ? legIds : [legIds]);
  const legs = sideArr(book, side);
  if (!legs.length) return { ok: true, closed: null, book };

  const fillPrice = side === 'long' ? mark * (1 - SLIP) : mark * (1 + SLIP);
  let pnl = 0;
  let fee = 0;
  let notional = 0;
  let qty = 0;
  const keep = [];
  for (const leg of legs) {
    if (!ids.has(leg.id)) {
      keep.push(leg);
      continue;
    }
    const q = Number(leg.qty) || 0;
    const entry = Number(leg.entryPrice) || 0;
    pnl += side === 'long' ? (fillPrice - entry) * q : (entry - fillPrice) * q;
    notional += q * fillPrice;
    fee += q * fillPrice * FEE;
    qty += q;
  }
  if (qty <= 0) return { ok: true, closed: null, book };

  book.walletBalance = Number(book.walletBalance) + pnl - fee;
  book.realizedPnl = Number(book.realizedPnl || 0) + pnl;
  book.feePaid = Number(book.feePaid || 0) + fee;
  book.lastPrice = mark;
  book.updatedAt = Date.now();
  book.positions[side] = keep;

  return {
    ok: true,
    book,
    closed: {
      side: side === 'long' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
      qty,
      price: fillPrice,
      notional,
      pnl,
      fee,
      reason,
    },
  };
}

/** 清空所有方向 */
export function closeAll(book, price, reason = 'stop') {
  const a = closeSide(book, 'long', price, reason);
  const b = closeSide(a.book, 'short', price, reason);
  return { ok: true, book: b.book, closed: [a.closed, b.closed].filter(Boolean) };
}

/** 快照（给 /api/account/overview 与前端用） */
export function snapshot(book, symbol, markPrice) {
  const out = [];
  for (const side of ['long', 'short']) {
    const s = summarizeSide(book, side, markPrice);
    if (s.qty > 0) {
      out.push({
        symbol,
        side,
        qty: round(s.qty, 8),
        entryPrice: round(s.avgEntry, 6),
        markPrice: round(markPrice, 6),
        unrealizedPnl: round(s.unrealizedPnl, 4),
        liqPrice: 0,
        leverage: (book.positions[side][0] || {}).leverage || 20,
        margin: round(s.margin, 4),
        layers: s.legs,
      });
    }
  }
  return out;
}

function round(v, d) {
  return Number.isFinite(v) ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : 0;
}

export const paperExchange = {
  type: 'paper',
  createBook,
  equityOf,
  openPosition,
  closeSide,
  closeLegs,
  closeAll,
  summarizeSide,
  snapshot,
};
