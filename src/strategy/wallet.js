/**
 * 模拟盘「账户钱包」——账户级共享资金池。
 *
 * 语义对齐币安 U 本位合约的全仓账户：
 *   - 一个用户只有一个钱包（paper_accounts 一行），余额是账户级的，不是每个机器人一份。
 *   - 所有模拟机器人从这里占用保证金：开仓扣手续费、平仓按盈亏加减。
 *   - 钱包余额为 0 时无法开新机器人（因为没有钱可以占用）。
 *
 * 数据分家：
 *   - 现金（balance / realized_pnl / fee_paid）  -> data/app.db 的 paper_accounts
 *   - 持仓（positions / lastPrice）              -> robots.paper_json（每个机器人自己的仓位）
 * 每次 tick 时把两者拼成一个「book」交给 paper.js 计算，算完把现金差额写回钱包。
 */

import { all, get, run } from '../db.js';

/** 默认首次开户余额（老数据迁移兜底用） */
const DEFAULT_OPEN_BALANCE = 100;
/** 模拟资金上下限，与前端表单一致 */
export const MIN_BALANCE = 10;
export const MAX_BALANCE = 10000000;

function nowTs() {
  return Date.now();
}

/**
 * 老数据迁移：paper_accounts 还没有该用户时，用其名下所有 paper 机器人
 * 历史 paper_json.walletBalance 之和作为初始余额（没有机器人就用默认 100）。
 * 这样升级后用户看到的钱不会凭空消失或凭空多出来。
 */
function legacyBalanceOf(userId) {
  let rows = [];
  try {
    rows = all(
      'SELECT paper_json FROM robots WHERE user_id = ? AND mode = ?',
      userId,
      'paper'
    );
  } catch {
    rows = [];
  }
  if (!rows || rows.length === 0) return { balance: DEFAULT_OPEN_BALANCE, count: 0 };
  let total = 0;
  let counted = 0;
  for (const row of rows) {
    let parsed = null;
    try {
      parsed = row && row.paper_json ? JSON.parse(row.paper_json) : null;
    } catch {
      parsed = null;
    }
    if (parsed && Number.isFinite(Number(parsed.walletBalance))) {
      total += Number(parsed.walletBalance);
      counted += 1;
    }
  }
  if (counted === 0) return { balance: DEFAULT_OPEN_BALANCE, count: rows.length };
  return { balance: total, count: rows.length };
}

/**
 * 取钱包；不存在则开户（会自动迁移老数据）。
 * @returns {{userId:string,balance:number,initialBalance:number,realizedPnl:number,feePaid:number,createdAt:number,updatedAt:number}}
 */
export function getWallet(userId) {
  let row = get('SELECT * FROM paper_accounts WHERE user_id = ?', userId);
  if (!row) {
    const legacy = legacyBalanceOf(userId);
    const ts = nowTs();
    run(
      `INSERT OR IGNORE INTO paper_accounts
        (user_id, balance, initial_balance, realized_pnl, fee_paid, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`,
      userId,
      legacy.balance,
      legacy.balance,
      ts,
      ts
    );
    row = get('SELECT * FROM paper_accounts WHERE user_id = ?', userId);
  }
  return shapeWallet(row);
}

/** 只读查询，不自动开户（用于概览等不该产生副作用的场景） */
export function peekWallet(userId) {
  const row = get('SELECT * FROM paper_accounts WHERE user_id = ?', userId);
  return row ? shapeWallet(row) : null;
}

function shapeWallet(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    balance: Number(row.balance || 0),
    initialBalance: Number(row.initial_balance || 0),
    realizedPnl: Number(row.realized_pnl || 0),
    feePaid: Number(row.fee_paid || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

/** 设置账户钱包余额（重置口径：初始余额 = 当前余额，已实现盈亏与手续费清零） */
export function setWalletBalance(userId, amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error('余额必须是数字');
  if (value < MIN_BALANCE) throw new Error(`模拟资金不能小于 ${MIN_BALANCE} USDT`);
  if (value > MAX_BALANCE) throw new Error(`模拟资金不能超过 ${MAX_BALANCE.toLocaleString('en-US')} USDT`);
  getWallet(userId); // 确保已开户
  const ts = nowTs();
  run(
    `UPDATE paper_accounts
        SET balance = ?, initial_balance = ?, realized_pnl = 0, fee_paid = 0, updated_at = ?
      WHERE user_id = ?`,
    value,
    value,
    ts,
    userId
  );
  return getWallet(userId);
}

/**
 * 按增量更新钱包现金。所有参数都是「本次 tick 产生的差额」。
 * @param {string} userId
 * @param {{cashDelta?:number, pnlDelta?:number, feeDelta?:number}} delta
 */
export function applyWalletDelta(userId, delta = {}) {
  const cash = Number(delta.cashDelta || 0);
  const pnl = Number(delta.pnlDelta || 0);
  const fee = Number(delta.feeDelta || 0);
  if (!cash && !pnl && !fee) return getWallet(userId);
  getWallet(userId); // 确保已开户
  run(
    `UPDATE paper_accounts
        SET balance = balance + ?, realized_pnl = realized_pnl + ?, fee_paid = fee_paid + ?, updated_at = ?
      WHERE user_id = ?`,
    cash,
    pnl,
    fee,
    nowTs(),
    userId
  );
  return getWallet(userId);
}

/**
 * 把「机器人仓位」和「账户钱包现金」拼成一个 paper.js 能直接吃的 book。
 * paper.js 完全不用改：它的 walletBalance 就是账户现金。
 * @param {object|null} robotBook robots.paper_json 解出来的持仓账本（可为空）
 * @param {object|null} wallet 账户钱包
 */
export function mergeBook(robotBook, wallet) {
  const base = robotBook && typeof robotBook === 'object' ? robotBook : {};
  const positions = base.positions && typeof base.positions === 'object' ? base.positions : {};
  const w = wallet || {};
  return {
    // 现金三项来自账户钱包
    walletBalance: Number(w.balance || 0),
    initialCapital: Number(w.initialBalance || 0),
    // 机器人自己累计的已实现盈亏与手续费（用于卡片展示，不影响账户现金口径）
    realizedPnl: Number(base.realizedPnl || 0),
    feePaid: Number(base.feePaid || 0),
    // 仓位来自机器人自己的账本
    positions: {
      long: Array.isArray(positions.long) ? positions.long : [],
      short: Array.isArray(positions.short) ? positions.short : [],
    },
    lastPrice: Number(base.lastPrice || 0),
    updatedAt: Number(base.updatedAt || nowTs()),
  };
}

/**
 * 从合并后的 book 里抽回「只属于机器人」的部分（持仓 + 机器人自己的盈亏累计），
 * 用于写回 robots.paper_json，避免把账户现金固化到机器人账本里。
 */
export function splitBook(book) {
  return {
    realizedPnl: Number(book.realizedPnl || 0),
    feePaid: Number(book.feePaid || 0),
    positions: {
      long: Array.isArray(book.positions && book.positions.long) ? book.positions.long : [],
      short: Array.isArray(book.positions && book.positions.short) ? book.positions.short : [],
    },
    lastPrice: Number(book.lastPrice || 0),
    updatedAt: nowTs(),
  };
}

/**
 * 计算用户当前可直接用于开仓的余额（钱包余额 − 已占用保证金）。
 * 这是「全仓」语义：多个机器人共用同一个钱包，谁也不能把别家已占用的保证金拿去用。
 * @param {string} userId
 */
export function availableForUser(userId) {
  const wallet = getWallet(userId);
  let used = 0;
  try {
    const rows = all(
      "SELECT paper_json FROM robots WHERE user_id = ? AND mode = 'paper'",
      userId
    );
    for (const row of rows) {
      let book = null;
      try {
        book = row.paper_json ? JSON.parse(row.paper_json) : null;
      } catch {
        book = null;
      }
      if (!book || !book.positions) continue;
      for (const side of ['long', 'short']) {
        for (const leg of book.positions[side] || []) {
          const m = Number(leg.margin);
          if (Number.isFinite(m) && m > 0) used += m;
        }
      }
    }
  } catch {
    used = 0;
  }
  const balance = Number(wallet.balance || 0);
  return {
    balance,
    usedMargin: Number(used.toFixed(8)),
    available: Number((balance - used).toFixed(8)),
  };
}

/** 汇总钱包健康度（供概览用） */
export function walletSummary(userId) {
  const w = getWallet(userId);
  return {
    balance: w.balance,
    initialBalance: w.initialBalance,
    realizedPnl: w.realizedPnl,
    feePaid: w.feePaid,
    totalPnl: w.balance - w.initialBalance,
    pnlPct: w.initialBalance > 0 ? ((w.balance - w.initialBalance) / w.initialBalance) * 100 : 0,
  };
}
