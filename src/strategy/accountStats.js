/**
 * 账户级统计：权益快照 + 今日盈亏口径。
 *
 * 为什么单独一张表：
 *   单机器人的 equity_curve 只代表「那台机器人」，而模拟盘的钱是全账户共享的
 *   一个钱包（paper_accounts）。用单机器人曲线当概览曲线，会出现
 *   「改一次余额曲线就垂直跳水」「两台机器人量级差 200 倍」这种怪象。
 *   所以这里按 user + mode 记一条独立时间线。
 *
 * 今日盈亏口径：
 *   今日盈亏 = 当前权益 − 当日开盘基准。
 *   基准在每天第一次取数时落库（取昨天最后一条快照，没有则取当前权益），
 *   用户手动设置模拟余额（相当于入金/出金）时同步重置基准，
 *   避免把「充值」算成「赚了」、把「提现」算成「亏了」。
 */

import { all, get, run } from '../db.js';
import { getMarketFeed } from '../binance/index.js';
import { getWallet } from './wallet.js';

/** 快照最小间隔：太快没意义，还会把库写爆 */
const SNAP_MIN_MS = 15000;
/** 曲线默认保留点数 */
const CURVE_LIMIT = 500;

/** userId+mode -> 上次写快照的时间戳（仅内存节流） */
const lastSnap = new Map();

function nowTs() {
  return Date.now();
}

/** 本地时区的 YYYY-MM-DD，用作用户视角的「今天」 */
export function dayKey(ts = nowTs()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 汇总模拟盘的账户状态（现金来自共享钱包，浮动盈亏来自各机器人自己的仓位）。
 * @param {string} userId
 */
export function paperSnapshot(userId) {
  const wallet = getWallet(userId);
  let rows = [];
  try {
    rows = all('SELECT * FROM robots WHERE user_id = ? AND mode = ?', userId, 'paper');
  } catch {
    rows = [];
  }
  const feed = getMarketFeed();
  let unrealized = 0;
  let usedMargin = 0;
  let positionCount = 0;
  for (const row of rows || []) {
    let book = null;
    try {
      book = row && row.paper_json ? JSON.parse(row.paper_json) : null;
    } catch {
      book = null;
    }
    if (!book || !book.positions) continue;
    let price = 0;
    try {
      price = num(feed.getPrice(row.symbol));
    } catch {
      price = 0;
    }
    if (!(price > 0)) continue;
    for (const side of ['long', 'short']) {
      const legs = Array.isArray(book.positions[side]) ? book.positions[side] : [];
      for (const leg of legs) {
        const qty = num(leg.qty);
        const entry = num(leg.entryPrice);
        if (qty <= 0) continue;
        unrealized += side === 'long' ? (price - entry) * qty : (entry - price) * qty;
        usedMargin += num(leg.margin);
        positionCount += 1;
      }
    }
  }
  const balance = num(wallet.balance);
  return {
    mode: 'paper',
    equity: balance + unrealized,
    walletBalance: balance,
    unrealizedPnl: unrealized,
    realizedPnl: num(wallet.realizedPnl),
    usedMargin,
    positionCount,
    initialBalance: num(wallet.initialBalance),
  };
}

/**
 * 写一条账户级权益快照（带节流，默认 15 秒一条）。
 * @param {string} userId
 * @param {'paper'|'live'} mode
 * @param {{equity:number,walletBalance?:number,unrealizedPnl?:number,realizedPnl?:number}} snap
 */
export function recordAccountEquity(userId, mode, snap) {
  if (!userId || !snap || !Number.isFinite(num(snap.equity))) return null;
  const key = `${userId}:${mode}`;
  const now = nowTs();
  const prev = lastSnap.get(key) || 0;
  if (now - prev < SNAP_MIN_MS) return null;
  lastSnap.set(key, now);
  try {
    run(
      `INSERT INTO account_equity (user_id, mode, ts, equity, wallet_balance, unrealized_pnl, realized_pnl)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      userId,
      mode,
      now,
      num(snap.equity),
      num(snap.walletBalance),
      num(snap.unrealizedPnl),
      num(snap.realizedPnl),
    );
  } catch {
    return null;
  }
  // 只保留最近 5000 条，避免库无限长大
  try {
    run(
      `DELETE FROM account_equity
        WHERE user_id = ? AND mode = ?
          AND id NOT IN (SELECT id FROM account_equity WHERE user_id = ? AND mode = ? ORDER BY ts DESC LIMIT 5000)`,
      userId,
      mode,
      userId,
      mode,
    );
  } catch {
    /* 忽略 */
  }
  return now;
}

/**
 * 读取账户级权益曲线（时间升序，最多 limit 点）。
 */
export function accountCurve(userId, mode, limit = CURVE_LIMIT) {
  const n = Math.min(Math.max(Number(limit) || CURVE_LIMIT, 2), 2000);
  let rows = [];
  try {
    rows = all(
      `SELECT ts, equity, wallet_balance, unrealized_pnl, realized_pnl
         FROM account_equity WHERE user_id = ? AND mode = ? ORDER BY ts DESC LIMIT ?`,
      userId,
      mode,
      n,
    );
  } catch {
    rows = [];
  }
  rows = (rows || []).reverse();
  return rows.map((r) => ({
    ts: num(r.ts),
    equity: num(r.equity),
    walletBalance: num(r.wallet_balance),
    unrealizedPnl: num(r.unrealized_pnl),
    realizedPnl: num(r.realized_pnl),
  }));
}

/**
 * 取（必要时建立）当日开盘基准。
 * 新的一天第一次调用时：优先用昨天/之前最后一条快照的权益，没有就用传入的 equity。
 */
export function ensureDailyBase(userId, mode, equity) {
  const day = dayKey();
  let row = null;
  try {
    row = get(
      'SELECT start_equity FROM account_daily WHERE user_id = ? AND mode = ? AND day = ?',
      userId,
      mode,
      day,
    );
  } catch {
    row = null;
  }
  if (row && Number.isFinite(num(row.start_equity))) return num(row.start_equity);

  let base = num(equity);
  try {
    const prev = get(
      'SELECT equity FROM account_equity WHERE user_id = ? AND mode = ? ORDER BY ts DESC LIMIT 1',
      userId,
      mode,
    );
    if (prev && Number.isFinite(num(prev.equity)) && num(prev.equity) > 0) base = num(prev.equity);
  } catch {
    /* 用当前权益兜底 */
  }
  try {
    run(
      `INSERT INTO account_daily (user_id, mode, day, start_equity, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, mode, day) DO NOTHING`,
      userId,
      mode,
      day,
      base,
      nowTs(),
    );
  } catch {
    /* 忽略 */
  }
  return base;
}

/**
 * 手动入金/出金后重置当日基准（否则改余额会被算成今日盈亏）。
 */
export function resetDailyBase(userId, mode, equity) {
  const day = dayKey();
  try {
    run(
      `INSERT INTO account_daily (user_id, mode, day, start_equity, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, mode, day) DO UPDATE SET start_equity = excluded.start_equity, updated_at = excluded.updated_at`,
      userId,
      mode,
      day,
      num(equity),
      nowTs(),
    );
  } catch {
    /* 忽略 */
  }
}

/**
 * 今日盈亏 = 当前权益 − 当日基准。
 * @returns {{pnl:number, pct:number, base:number, day:string}}
 */
export function todayPnl(userId, mode, equity) {
  const base = ensureDailyBase(userId, mode, equity);
  const pnl = num(equity) - base;
  const pct = base > 0 ? (pnl / base) * 100 : 0;
  return { pnl, pct, base, day: dayKey() };
}
