/**
 * 账户路由。
 * GET /api/account/overview?mode=paper|live
 *
 * 实盘模式下如果连不上币安或没有 Key，**必须优雅降级**：
 * 返回 degraded 标记 + 中文原因，绝不抛 500 白屏。
 */
import { requireAuth, HttpError } from '../http.js';
import { all, get, run } from '../db.js';
import { getExchange, loadCredentials, getMarketFeed } from '../binance/index.js';
import { isNetworkError } from '../binance/rest.js';
import { getWallet, setWalletBalance } from '../strategy/wallet.js';
import { tpTargetFor, stopTargetFor, liqPrice, safeStop } from '../strategy/solver.js';
import { protectionFromOrders } from '../binance/protection.js';
import { normalizeParams } from '../strategy/params.js';
import {
  paperSnapshot,
  recordAccountEquity,
  accountCurve,
  ensureDailyBase,
  todayPnl as todayPnlStat,
  resetDailyBase,
} from '../strategy/accountStats.js';

export default function register(app) {
  app.get('/api/account/overview', async (ctx) => {
    const u = requireAuth(ctx);
    const mode = ctx.query.mode === 'live' ? 'live' : 'paper';

    if (mode === 'paper') {
      return paperOverview(u.id);
    }
    return liveOverview(u.id);
  });

  /**
   * 模拟盘账户钱包明细。
   * 余额是**账户级**的（一个用户一个钱包），机器人只是从钱包里占用保证金。
   */
  /**
   * 账户级权益曲线（概览页用）。
   * ?mode=paper|live&limit=500
   */
  app.get('/api/account/equity-curve', async (ctx) => {
    const u = requireAuth(ctx);
    const mode = ctx.query.mode === 'live' ? 'live' : 'paper';
    const limit = Math.min(Math.max(num(ctx.query.limit) || 500, 2), 2000);
    let points = accountCurve(u.id, mode, limit);

    // 没有历史（新账号/刚升级）时，用「当日基准」补一个起点，避免前端画空图或一根竖线
    if (points.length < 2 && mode === 'paper') {
      try {
        const snap = paperSnapshot(u.id);
        const now = Date.now();
        const base = ensureDailyBase(u.id, 'paper', snap.equity);
        const startTs = now - 24 * 3600 * 1000;
        const startPoint = {
          ts: startTs,
          equity: base,
          walletBalance: base,
          unrealizedPnl: 0,
          realizedPnl: snap.realizedPnl,
        };
        const curPoint = {
          ts: points.length ? points[points.length - 1].ts + 1 : now,
          equity: snap.equity,
          walletBalance: snap.walletBalance,
          unrealizedPnl: snap.unrealizedPnl,
          realizedPnl: snap.realizedPnl,
        };
        points = points.length ? [startPoint, ...points] : [startPoint, curPoint];
        if (points.length < 2) points = [startPoint, curPoint];
      } catch {
        /* 保底失败就返回原样 */
      }
    }
    return {
      mode,
      points: points.map((p) => ({
        ts: p.ts,
        equity: round(p.equity, 4),
        walletBalance: round(p.walletBalance, 4),
        unrealizedPnl: round(p.unrealizedPnl, 4),
        realizedPnl: round(p.realizedPnl, 4),
      })),
    };
  });

  app.get('/api/account/paper/balance', async (ctx) => {
    const u = requireAuth(ctx);
    const wallet = getWallet(u.id);
    const rows = all(
      "SELECT * FROM robots WHERE user_id = ? AND mode = 'paper' ORDER BY created_at DESC",
      u.id,
    );
    const books = rows.map((row) => {
      let book = null;
      try {
        book = row.paper_json ? JSON.parse(row.paper_json) : null;
      } catch {
        book = null;
      }
      return {
        robotId: row.id,
        name: row.name,
        symbol: row.symbol,
        status: row.status,
        longQty: round(sumQty(book, 'long'), 8),
        shortQty: round(sumQty(book, 'short'), 8),
        layers: countLegs(book),
      };
    });
    return {
      // 账户钱包（账号级，只有一个数字）
      balance: round(wallet.balance, 4),
      initialBalance: round(wallet.initialBalance, 4),
      realizedPnl: round(wallet.realizedPnl, 4),
      feePaid: round(wallet.feePaid, 4),
      updatedAt: wallet.updatedAt,
      // 当前有多少个模拟机器人在用这个钱包
      count: books.length,
      total: round(wallet.balance, 4),
      books,
    };
  });

  /**
   * 设置模拟盘「账户钱包」余额。
   * body: { amount: 数字, resetRobots?: boolean }
   *   - 只改账户钱包一个数字，与机器人个数无关；
   *   - 默认同时把所有模拟机器人停机并清空持仓/订单，避免旧仓位用新余额继续算；
   *   - resetRobots=false 时保留机器人持仓。
   */
  app.post('/api/account/paper/balance', async (ctx) => {
    const u = requireAuth(ctx);
    const body = ctx.body || {};
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 10) {
      throw new HttpError(400, 'BAD_AMOUNT', '模拟资金不能小于 10 USDT');
    }
    if (amount > 10000000) {
      throw new HttpError(400, 'BAD_AMOUNT', '模拟资金不能超过 10,000,000 USDT');
    }

    const wallet = setWalletBalance(u.id, amount);
    const resetRobots = body.resetRobots !== false;
    const rows = all(
      "SELECT * FROM robots WHERE user_id = ? AND mode = 'paper' ORDER BY created_at DESC",
      u.id,
    );

    const runner = await importRunner();
    const touched = [];
    if (resetRobots) {
      for (const row of rows) {
        try {
          if (runner && runner.isRunning && runner.isRunning(row.id)) {
            await runner.stopRobot(row.id);
          }
        } catch {
          /* 停止失败不阻断 */
        }
        run(
          `UPDATE robots SET paper_json = ?, state_json = NULL, status = 'stopped',
           started_at = NULL, last_tick = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
          JSON.stringify(emptyRobotBook()),
          Date.now(),
          row.id,
        );
        run('DELETE FROM orders WHERE robot_id = ?', row.id);
        run('DELETE FROM equity_curve WHERE robot_id = ?', row.id);
        run(
          'INSERT INTO events (user_id, robot_id, level, message, ts) VALUES (?, ?, ?, ?, ?)',
          u.id, row.id, 'info', `模拟钱包已设为 ${amount} USDT，该机器人持仓已清空`, Date.now(),
        );
        touched.push(row.id);
      }
    }
    run(
      'INSERT INTO events (user_id, robot_id, level, message, ts) VALUES (?, NULL, ?, ?, ?)',
      u.id, 'info', `模拟盘账户钱包设为 ${amount} USDT（重置 ${touched.length} 个机器人）`, Date.now(),
    );

    // 入金/出金不是盈亏：把今天的基准重置成新余额，否则今日盈亏会凭空多出/少掉一笔
    resetDailyBase(u.id, 'paper', amount);
    recordAccountEquity(u.id, 'paper', {
      equity: amount,
      walletBalance: amount,
      unrealizedPnl: 0,
      realizedPnl: num(wallet.realizedPnl),
    });

    return {
      amount: round(amount, 4),
      balance: round(wallet.balance, 4),
      count: touched.length,
      robotIds: touched,
      resetRobots,
    };
  });
}

async function importRunner() {
  try {
    return await import('../strategy/runner.js');
  } catch {
    return null;
  }
}

/** 机器人账本里只保留仓位，现金由账户钱包统一持有 */
function emptyRobotBook() {
  return {
    realizedPnl: 0,
    feePaid: 0,
    positions: { long: [], short: [] },
    lastPrice: 0,
    updatedAt: Date.now(),
  };
}

/** 模拟盘：账户钱包（一个数字）+ 各机器人未实现盈亏 */
function paperOverview(userId) {
  const rows = all(
    "SELECT * FROM robots WHERE user_id = ? AND mode = 'paper' ORDER BY created_at DESC",
    userId,
  );
  const feed = getMarketFeed();
  const wallet = getWallet(userId);

  let unrealized = 0;
  let usedMargin = 0;
  const positions = [];
  let lastTs = num(wallet.updatedAt);

  for (const row of rows) {
    let robotBook = null;
    try {
      robotBook = row.paper_json ? JSON.parse(row.paper_json) : null;
    } catch {
      robotBook = null;
    }
    if (!robotBook) continue;
    const price = safe(() => feed.getPrice(row.symbol), 0);
    unrealized += unrealizedOf(robotBook, price);
    lastTs = Math.max(lastTs, num(robotBook.updatedAt));

    // 这个机器人的策略参数（止盈/止损幅度），用来在持仓列表里显示目标价
    let rp = {};
    try {
      rp = normalizeParams(row.params_json ? JSON.parse(row.params_json) : {});
    } catch {
      rp = normalizeParams({});
    }
    const equity = num(wallet.balance) + unrealizedOf(robotBook, price);

    for (const side of ['long', 'short']) {
      const legs = (robotBook.positions && robotBook.positions[side]) || [];
      if (!legs.length) continue;
      let qty = 0;
      let notional = 0;
      let margin = 0;
      for (const leg of legs) {
        qty += num(leg.qty);
        notional += num(leg.qty) * num(leg.entryPrice);
        margin += num(leg.margin);
      }
      usedMargin += margin;
      const avg = qty > 0 ? notional / qty : 0;
      const sideUpnl = side === 'long' ? (price - avg) * qty : (avg - price) * qty;
      const sideLiq = liqPrice(qty, avg, equity, side);
      positions.push({
        symbol: row.symbol,
        side,
        qty: round(qty, 8),
        entryPrice: round(avg, 6),
        markPrice: round(price, 6),
        unrealizedPnl: round(sideUpnl, 4),
        // 止盈 / 止损 / 强平：按当前实际持仓均价现算，跟机器人内部判定用的是同一套公式。
        // 止损必须夹在「入场价」与「强平价」之间，不能因为强平很近就翻到入场价另一侧。
        tpPrice: round(tpTargetFor(side, avg, rp), 6),
        stopPrice: round(safeStop(
          side,
          stopTargetFor(side, avg, qty, equity, rp),
          avg,
          sideLiq,
        ), 6),
        liqPrice: sideLiq > 0 ? round(sideLiq, 6) : 0,
        tpPct: num(rp.tpPct),
        stopPct: num(rp.stopPct),
        tpMode: rp.tpMode || 'avg',
        leverage: num((legs[0] || {}).leverage) || 20,
        margin: round(margin, 4),
        layers: legs.length,
        robotId: row.id,
        robotName: row.name,
      });
    }
  }

  const balance = num(wallet.balance);
  const eqNow = balance + unrealized;
  // 今日盈亏 = 当前权益 − 当日基准（不再用「手续费取负」这种错口径）
  const tpStat = todayPnlStat(userId, 'paper', eqNow);
  const todayReal = todayRealized(userId);
  recordAccountEquity(userId, 'paper', {
    equity: eqNow,
    walletBalance: balance,
    unrealizedPnl: unrealized,
    realizedPnl: num(wallet.realizedPnl),
  });
  return {
    mode: 'paper',
    // 权益 = 钱包余额 + 所有机器人未实现盈亏
    equity: round(balance + unrealized, 4),
    walletBalance: round(balance, 4),
    initialBalance: round(wallet.initialBalance, 4),
    // 可用 = 钱包余额 − 已被占用的保证金
    availableBalance: round(balance - usedMargin, 4),
    usedMargin: round(usedMargin, 4),
    unrealizedPnl: round(unrealized, 4),
    realizedPnl: round(wallet.realizedPnl, 4),
    totalFee: round(wallet.feePaid, 4),
    todayPnl: round(tpStat.pnl, 4),
    todayPnlPct: round(tpStat.pct, 4),
    todayBaseEquity: round(tpStat.base, 4),
    // 今日「已落袋」收益 = 今日平仓盈亏 − 今日手续费（与含浮亏的 todayPnl 两个口径都给）
    todayRealizedPnl: round(todayReal, 4),
    positions,
    updatedAt: lastTs || Date.now(),
    live: { configured: false, verified: false, error: null },
  };
}

/** 实盘：调币安，失败则降级返回 */
async function liveOverview(userId) {
  const creds = loadCredentials(userId);
  const keyRow = get(
    "SELECT * FROM api_keys WHERE user_id = ? ORDER BY (status = 'verified') DESC, created_at DESC LIMIT 1",
    userId,
  );
  const base = {
    mode: 'live',
    equity: 0,
    walletBalance: 0,
    availableBalance: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    todayPnl: 0,
    positions: [],
    updatedAt: Date.now(),
  };

  if (!creds) {
    return {
      ...base,
      live: {
        configured: Boolean(keyRow),
        verified: Boolean(keyRow && keyRow.status === 'verified'),
        error: keyRow
          ? (keyRow.status === 'incomplete'
            ? 'API Key 已保存，但缺少 API Secret：币安账户接口必须用 Secret 签名，只有 Key 读不到余额'
            : 'API Key 已保存但尚未验证通过，请到「API Key」页面点击验证')
          : '尚未配置 API Key。请在「API Key」页面添加币安 U 本位合约的密钥',
        missingSecret: Boolean(keyRow && keyRow.status === 'incomplete'),
      },
    };
  }

  try {
    const ex = getExchange('live');
    const acc = await ex.fetchAccount(creds);

    // 关键：止盈/止损价一律以「币安上真实挂着的条件单」为准。
    // 用户手动在币安挂的止盈止损，平台必须原样显示，不能自己用参数估算。
    let liveOrders = [];
    let ordersError = null;
    try {
      liveOrders = (await ex.fetchOpenOrders(creds)) || [];
    } catch (e) {
      ordersError = (e && e.message) || String(e);
    }

    const liveRobots = all(
      "SELECT * FROM robots WHERE user_id = ? AND mode = 'live'",
      userId,
    );
    const posList = (acc.positions || []).map((pos) => {
      const rb = liveRobots.find((r) => r.symbol === pos.symbol);
      let rp = normalizeParams({});
      if (rb) {
        try {
          rp = normalizeParams(rb.params_json ? JSON.parse(rb.params_json) : {});
        } catch {
          rp = normalizeParams({});
        }
      }
      const q = num(pos.qty);
      const avg = num(pos.entryPrice);
      const mark = num(pos.markPrice);
      const liqRaw = num(pos.liqPrice);
      const liq = liqRaw > 0 ? liqRaw : 0;

      // 先找币安上真实挂着的止盈/止损条件单
      const prot = protectionFromOrders(liveOrders, {
        symbol: pos.symbol,
        side: pos.side,
        markPrice: mark,
      });

      // 实盘只显示「真实挂单」。币安上没有挂就是没有，绝不编一个数字出来。
      // 只有在读不到挂单列表（网络/权限失败）时，才退回参数估算并标注「估算」。
      const ordersUnavailable = Boolean(ordersError);
      const estTp = round(tpTargetFor(pos.side, avg, rp), 6);
      const estStop = round(safeStop(
        pos.side,
        stopTargetFor(pos.side, avg, q, acc.equity, rp),
        avg,
        liq,
      ), 6);

      const tpPrice = prot.tpPrice > 0
        ? round(prot.tpPrice, 6)
        : (ordersUnavailable ? estTp : 0);
      const stopPrice = prot.stopPrice > 0
        ? round(prot.stopPrice, 6)
        : (ordersUnavailable ? estStop : 0);

      // 机器人自己的持仓账本：币安双向持仓下同一 symbol 的持仓是账户级聚合的，
      // 要区分「机器人开的」和「用户手动开的」，否则用户会误以为机器人托管了全部仓位。
      let ownQty = 0;
      if (rb) {
        let st = null;
        try {
          st = rb.state_json ? JSON.parse(rb.state_json) : null;
        } catch {
          st = null;
        }
        const legsArr = (st && st.liveLegs && st.liveLegs[pos.side]) || [];
        ownQty = legsArr.reduce((acc, l) => acc + num(l.qty), 0);
      }
      const manualQty = Math.max(0, q - ownQty);

      return {
        ...pos,
        liqPrice: liq,
        ownQty: round(ownQty, 8),
        manualQty: round(manualQty, 8),
        tpPrice,
        stopPrice,
        // 是否来自币安真实挂单（false 且价格>0 说明是读不到挂单时的估算）
        tpFromOrder: prot.tpPrice > 0,
        stopFromOrder: prot.stopPrice > 0,
        hasTpOrder: prot.tpCount > 0,
        hasStopOrder: prot.stopCount > 0,
        tpCount: prot.tpCount,
        stopCount: prot.stopCount,
        tpPrices: prot.tpPrices,
        stopPrices: prot.stopPrices,
        protectionSource: ordersUnavailable ? 'estimate' : (prot.tpCount || prot.stopCount ? 'order' : 'none'),
        ordersError,
        tpPct: num(rp.tpPct),
        stopPct: num(rp.stopPct),
        tpMode: rp.tpMode || 'avg',
        robotId: rb ? rb.id : null,
        robotName: rb ? rb.name : '（手动持仓）',
      };
    });
    const tpLive = todayPnlStat(userId, 'live', num(acc.equity));
    recordAccountEquity(userId, 'live', {
      equity: num(acc.equity),
      walletBalance: num(acc.walletBalance),
      unrealizedPnl: num(acc.unrealizedPnl),
      realizedPnl: num(acc.realizedPnl),
    });
    return {
      ...base,
      equity: acc.equity,
      walletBalance: acc.walletBalance,
      availableBalance: acc.availableBalance,
      unrealizedPnl: acc.unrealizedPnl,
      realizedPnl: acc.realizedPnl,
      totalInitialMargin: acc.totalInitialMargin,
      totalMaintMargin: acc.totalMaintMargin,
      todayPnl: round(tpLive.pnl, 4),
      todayPnlPct: round(tpLive.pct, 4),
      todayBaseEquity: round(tpLive.base, 4),
      positions: posList,
      updatedAt: acc.updatedAt,
      live: { configured: true, verified: true, error: null },
    };
  } catch (err) {
    return {
      ...base,
      live: {
        configured: true,
        verified: Boolean(keyRow && keyRow.status === 'verified'),
        error: isNetworkError(err)
          ? `无法连接币安：${err.message}`
          : `读取实盘账户失败：${(err && err.message) || err}`,
        networkDown: isNetworkError(err),
      },
      degraded: true,
    };
  }
}

function unrealizedOf(book, price) {
  let sum = 0;
  for (const side of ['long', 'short']) {
    for (const leg of (book.positions && book.positions[side]) || []) {
      const q = num(leg.qty);
      const e = num(leg.entryPrice);
      sum += side === 'long' ? (price - e) * q : (e - price) * q;
    }
  }
  return sum;
}

/**
 * 今日已落袋收益 = 今日平仓盈亏合计 − 今日手续费合计。
 * 与「今日盈亏（权益变化，含浮动）」区分开：用户看平仓赚了钱，这里必须是正的。
 */
function todayRealized(userId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = get(
    `SELECT COALESCE(SUM(realized_pnl), 0) AS pnl, COALESCE(SUM(fee), 0) AS fee
       FROM orders WHERE user_id = ? AND created_at >= ?`,
    userId,
    start.getTime(),
  );
  return num(row && row.pnl) - num(row && row.fee);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 某方向累计持仓数量 */
function sumQty(book, side) {
  if (!book || !book.positions) return 0;
  let q = 0;
  for (const leg of book.positions[side] || []) q += num(leg.qty);
  return q;
}

/** 机器人腿数（多空合计） */
function countLegs(book) {
  if (!book || !book.positions) return 0;
  return (book.positions.long || []).length + (book.positions.short || []).length;
}
function round(v, d) {
  return Number.isFinite(v) ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : 0;
}
function safe(fn, fb) {
  try {
    const v = fn();
    return Number.isFinite(Number(v)) ? Number(v) : fb;
  } catch {
    return fb;
  }
}
