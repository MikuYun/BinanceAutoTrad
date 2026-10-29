/**
 * 调度器：每个运行中的机器人一个定时器，按 interval 做决策并落库。
 *
 * 设计要点：
 *   1. 单例 Map 持有所有运行中的机器人，启动时可从数据库恢复（bootAll）；
 *   2. 每 tick 完整重算计划（权益/ATR 都变），不缓存过期计划；
 *   3. 所有副作用（下单、写库）都 try/catch，单个机器人出错不能拖垮进程；
 *   4. 实盘模式额外做「对账」：以交易所持仓为准，不用本地状态臆测。
 */
import { get, run, all, tx } from '../db.js';
import { randomId } from '../crypto.js';
import { PAPER, TRADING } from '../config.js';
import { decide } from './engine.js';
import { normalizeParams } from './params.js';
import { getWallet, mergeBook, splitBook, applyWalletDelta, availableForUser } from './wallet.js';
import { getMarketFeed, getExchange, loadCredentials } from '../binance/index.js';
import { recordAccountEquity } from './accountStats.js';
import {
  emptyLiveLegs, parseLiveLegs, addLeg, drainQty, drainLegs, reconcile, bookOf,
  ownQty, ownAvgEntry, filterBySymbol, parseTakeover, emptyTakeover,
} from './liveBook.js';
import { tpTargetFor, stopTargetFor, liqPrice } from './solver.js';
import { desiredCondOrders, diffCondOrders, normalizeCondOrders } from './protect.js';
import {
  makeClientId, placeConditional, cancelByClientId, fetchAllOpenOrders, fetchAccount,
} from '../binance/live.js';

/** 每个机器人的 tick 间隔 */
const TICK = { intervalMs: PAPER.tickIntervalMs };

/** 实盘连续下单错误计数：达到阈值就自动停机（P0-5） */
const ORDER_ERROR_LIMIT = 3;
const orderErrors = new Map();

function markOrderError(entry) {
  const n = (orderErrors.get(entry.robotId) || 0) + 1;
  orderErrors.set(entry.robotId, n);
  if (n < ORDER_ERROR_LIMIT) return;
  orderErrors.delete(entry.robotId);
  logEvent(
    entry.userId,
    entry.robotId,
    'error',
    `实盘连续 ${ORDER_ERROR_LIMIT} 次下单/执行失败，机器人已自动停止。请排查后重新启动。`,
  );
  saveRobot(entry.robotId, { status: 'stopped', started_at: null });
  stopRobot(entry.robotId);
}

function clearOrderErrors(robotId) {
  orderErrors.delete(robotId);
}

/** robotId -> { timer, robot, params, mode, userId, symbol } */
const running = new Map();

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function logEvent(userId, robotId, level, message) {
  try {
    run(
      'INSERT INTO events (user_id, robot_id, level, message, ts) VALUES (?, ?, ?, ?, ?)',
      userId,
      robotId,
      level,
      String(message).slice(0, 500),
      Date.now(),
    );
  } catch {
    /* 日志失败不影响交易 */
  }
}

function saveRobot(robotId, patch) {
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(robotId);
  run(`UPDATE robots SET ${fields.join(', ')} WHERE id = ?`, ...values);
}

function recordOrder(userId, robotId, symbol, o) {
  const id = randomId('o');
  const ts = Date.now();
  // P0-1（docs/BUGFIX-PLAN-client-order-id-unique.md）：
  // client_id 撞唯一约束，绝对不能抛异常。上一版就是抛在这里，导致
  // 「交易所已成交、账本没记上」，下一 tick 以为没建仓又发一笔 → 重复开仓。
  // 同一个 client_id 就是同一笔意图，撞了当作已记录直接忽略。
  run(
    `INSERT INTO orders (id, user_id, robot_id, client_id, symbol, side, type, qty, price,
      avg_price, status, reduce_only, reason, fee, realized_pnl, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO NOTHING`,
    id,
    userId,
    robotId,
    o.clientId || id,
    symbol,
    o.side,
    o.type || 'MARKET',
    Number(o.qty) || 0,
    Number(o.price) || 0,
    Number(o.avgPrice || o.price) || 0,
    o.status || 'FILLED',
    o.reduceOnly ? 1 : 0,
    o.reason || '',
    Number(o.fee) || 0,
    Number(o.realizedPnl) || 0,
    ts,
    ts,
  );
  return id;
}

function recordEquity(robotId, equity, price) {
  try {
    run(
      'INSERT INTO equity_curve (robot_id, ts, equity, price, position_qty) VALUES (?, ?, ?, ?, ?)',
      robotId,
      Date.now(),
      Number(equity) || 0,
      Number(price) || 0,
      null,
    );
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 单次 tick
 * ------------------------------------------------------------------ */

async function tick(entry) {
  const { robotId, symbol, mode, params, userId } = entry;
  const feed = getMarketFeed();

  let price = 0;
  let atr = 0.02;
  try {
    price = feed.getPrice(symbol);
    // ATR 用异步接口取真实 K 线计算（同步接口只读缓存，可能还是兜底值）
    if (typeof feed.atrPctAsync === 'function') {
      atr = await feed.atrPctAsync(symbol, params.interval || '1h');
    } else if (typeof feed.atrPct === 'function') {
      atr = feed.atrPct(symbol, params.interval || '1h');
    }
  } catch (e) {
    logEvent(userId, robotId, 'warn', `行情读取失败：${e.message}`);
    return;
  }
  if (!(price > 0)) {
    logEvent(userId, robotId, 'warn', '当前价格无效，跳过本次决策');
    return;
  }

  let bars = [];
  try {
    if (typeof feed.klinesAsync === 'function') {
      bars = (await feed.klinesAsync(symbol, params.interval || '1h', 60)) || [];
    } else {
      bars = feed.klines(symbol, params.interval || '1h', 60) || [];
    }
  } catch {
    bars = [];
  }

  const row = get('SELECT * FROM robots WHERE id = ?', robotId);
  if (!row || row.status !== 'running') {
    stopRobot(robotId);
    return;
  }

  const exchange = getExchange(mode);
  const rules = mode === 'live' ? await getLiveRules(symbol) : PAPER_RULES;
  if (mode === 'live') warnDegradedRules(userId, robotId, symbol, rules);

  let book = null;
  let legs = null; // 实盘：机器人自己的持仓账本（含接管来的部分）
  let takeover = null; // 实盘：本次 tick 为止仍未平掉的接管仓位（这些方向只等止盈全平，不加仓）
  let wallet = null;
  let cashBefore = 0;
  let pnlBefore = 0;
  let feeBefore = 0;
  if (mode === 'paper') {
    wallet = getWallet(userId);
    book = mergeBook(parseJson(row.paper_json, null), wallet);
    cashBefore = Number(book.walletBalance || 0);
    pnlBefore = Number(book.realizedPnl || 0);
    feeBefore = Number(book.feePaid || 0);
  }

  let quote = null;
  let equity = 0;
  let liveRealizedDelta = 0; // 本次 tick 里实盘平仓带来的已实现盈亏（累加到 state.realizedPnl）
  let liveNotice = null; // 接管仓位提示的节流状态
  let condNext = null; // 实盘保护单（止盈/止损）同步后的账本
  let condWarn = ''; // 保护单没挂上的原因（避免每 5 秒刷一条事件）


  if (mode === 'paper') {
    equity = exchange.equityOf(book, price);
  } else {
    const creds = loadCredentials(userId);
    if (!creds) {
      logEvent(userId, robotId, 'error', '实盘模式缺少 API Key，自动停止');
      stopRobot(robotId);
      saveRobot(robotId, { status: 'stopped', last_error: '缺少 API Key' });
      return;
    }
    try {
      quote = await exchange.fetchAccount(creds);
      equity = quote.equity;
      // positionRisk 不带 symbol 时返回的是**整个账户所有交易对**的持仓，
      // 必须只留本机器人的交易对，否则：
      //   1. 页面「已建仓笔数」会把别的币的仓位也算进来（刚启动就显示满了）；
      //   2. 对账时可能拿 HYPEUSDT 的仓去当 BNBUSDT 的仓，平错数量。
      quote = {
        ...quote,
        positions: filterBySymbol(quote.positions, symbol),
      };
    } catch (e) {
      logEvent(userId, robotId, 'error', `实盘账户读取失败：${e.message}`);
      saveRobot(robotId, { last_error: e.message });
      return;
    }
    // 【接管模式】（用户 m06852 要求）
    // 机器人一旦启动，就接管这个交易对在交易所里的全部仓位。
    // 交易所是唯一真相源：
    //   · 交易所比账本多 → 多出来的部分接管进账本，均价用「交易所总名义 − 账本已有名义」反解，
    //     保证账本加权均价恰好等于交易所真实均价；
    //   · 交易所比账本少 → 有人手动减仓，按比例缩减账本；
    //   · 交易所已经空了 → 清空该方向账本。
    // 接管来的仓位不再加仓，只等「按真实均价算出的止盈价」一次性全平，平完再重新建第一层。
    const prevState = parseJson(row.state_json, null) || {};
    legs = parseLiveLegs(prevState);
    const prevTakeover = parseTakeover(prevState);
    const rec = reconcile(legs, quote.positions, prevTakeover, rules);
    legs = rec.legs;
    takeover = rec.takeover;
    // 日志节流：只在「首次发现」或「数量变化」时写事件，否则每 5 秒一条会刷屏
    const prevNotice = prevState.takeoverNotice || {};
    const notice = {};
    for (const side of ['long', 'short']) {
      const sideName = side === 'long' ? '多' : '空';
      if (rec.missing && rec.missing[side]) {
        logEvent(
          userId,
          robotId,
          'warn',
          `对账：${sideName}单在交易所已归零，机器人账本也同步清空。`
            + '下一次 tick 会重新建第一层。',
        );
      } else if (rec.drained && rec.drained[side] > Math.max(Number(rules.stepSize) / 2, 1e-8)) {
        logEvent(
          userId,
          robotId,
          'warn',
          `对账：${sideName}单在交易所少了 ${Number(rec.drained[side]).toFixed(6)} 张`
            + '（有人手动减了仓），机器人账本已同步缩减',
        );
      }
      const aq = rec.adopted && rec.adopted[side];
      if (aq > 1e-9) {
        const key = aq.toFixed(6);
        if (prevNotice[side] !== key) {
          const avgT = ownAvgEntry(legs, side);
          const tpT = tpTargetFor(side, avgT, params);
          logEvent(
            userId,
            robotId,
            'info',
            `接管：${sideName}单已有 ${aq.toFixed(6)} 张不是机器人开的仓位，已全部接管`
              + `（实际均价 ${avgT.toFixed(6)}）。接管仓位不加仓，等止盈价 ${tpT.toFixed(6)} 一次性全平。`,
          );
        }
        notice[side] = key;
      }
    }
    liveNotice = notice;
    book = bookOf(legs);
  }

  if (!(equity > 0)) {
    logEvent(userId, robotId, 'warn', '权益为 0，无法计算仓位');
    return;
  }

  // 计划价格锚定（用户问题 #7）：
  //   阶梯触发价不能跟着实时价跳，否则持仓期间止盈目标一直在漂。
  //   做法：空仓时把锚点定为成交瞬间的价格；持仓期间一直沿用这个锚点。
  //   完全平仓以后下一次重新建仓会拿到新锚点。
  const stForAnchor = parseJson(row.state_json, null) || {};
  const hasAnyLeg = Boolean(
    (legs && ((legs.long || []).length || (legs.short || []).length))
    || (book && (
      ((book.positions && book.positions.long) || []).length
      || ((book.positions && book.positions.short) || []).length
    )),
  );
  let anchorPrice = hasAnyLeg ? Number(stForAnchor.anchorPrice || 0) : 0;
  if (!(anchorPrice > 0)) anchorPrice = Number(price) || 0;

  // 资金基数里的「已实现盈亏」（用户 m05585 要求）：
  //   机器人只被授权动用「分配给它的资金」+「它自己已经赚到的钱」。
  //   模拟盘直接读账本；实盘读上一次 tick 写进 state 的累计值
  //   （本次平仓产生的增量下一次 tick 才并入，不影响仓位规模判断）。
  const ownRealizedPnl = mode === 'paper'
    ? Number((book && book.realizedPnl) || 0)
    : Number(stForAnchor.realizedPnl || 0);

  const result = decide({
    params,
    book,
    symbol,
    markPrice: price,
    equity,
    atrPct: atr,
    bars,
    rules,
    quote,
    anchorPrice,
    realizedPnl: ownRealizedPnl,
    takeover,
  });

  for (const note of result.notes || []) logEvent(userId, robotId, 'info', note);

  if (!result.actions.length) {
    const patch0 = { last_tick: Date.now() };
    if (mode === 'live' && legs) {
      // 没有动作也要把对账后的账本写回去，否则手动平仓后账本永远不收敛
      const st0 = parseJson(row.state_json, null) || {};
      // 即使没有动作，交易所上的仓位也可能被用户手动改过，这里同步一份给前端
      const pos0 = (quote.positions || [])
        .map((p2) => {
          const q2 = ownQty(legs, p2.side);
          return { ...p2, ownQty: q2, manualQty: Math.max(0, Number(p2.qty) - q2) };
        })
        .filter((p2) => Number(p2.ownQty) > 0 || Number(p2.manualQty) > 0);
      const ownUpnl0 = ['long', 'short'].reduce((sum, side) => {
        const q2 = ownQty(legs, side);
        if (!(q2 > 0)) return sum;
        const a2 = ownAvgEntry(legs, side);
        return sum + (side === 'long' ? (price - a2) * q2 : (a2 - price) * q2);
      }, 0);
      // 仓位没动也要周期性确认交易所上的止盈止损还挂着（可能被手动撤了，或已经成交）
      let cond0 = normalizeCondOrders(st0.condOrders);
      let condWarn0 = st0.condWarn || '';
      if (Date.now() - Number(st0.condSyncedAt || 0) > 60000) {
        const creds0 = loadCredentials(userId);
        if (creds0) {
          const sync0 = await syncProtection({
            creds: creds0, robotId, userId, symbol, legs, params, price, equity, rules,
            prevCondOrders: st0.condOrders, force: false,
          });
          cond0 = sync0.next;
          condWarn0 = sync0.warn || '';
          condNext = sync0.next;
          condWarn = sync0.warn || '';
          // 保护单挂不上是高风险：交易所侧裸仓，只能靠软件止损。必须留 error 级事件。
          if (sync0.severe) {
            logEvent(userId, robotId, 'error', `保护单异常：${sync0.severe}`);
          }
          if (sync0.changed) {
            logEvent(userId, robotId, 'info',
              `实盘止盈止损单已同步：新挂 ${sync0.placed} 个，撤销 ${sync0.canceled} 个`
                + (sync0.failed ? `，${sync0.failed} 个挂单失败` : ''));
          }
        }
      }
      patch0.state_json = JSON.stringify({
        ...st0,
        equity,
        balance: Number(quote.walletBalance) || 0,
        unrealizedPnl: ownUpnl0,
        positions: {
          long: pos0.filter((x) => x.side === 'long'),
          short: pos0.filter((x) => x.side === 'short'),
        },
        liveLegs: legs,
        takeover,
        takeoverNotice: liveNotice || st0.takeoverNotice || {},
        condOrders: cond0,
        condWarn: condWarn0,
        condSyncedAt: condNext ? Date.now() : Number(st0.condSyncedAt || 0),
        anchorPrice,
        plan: result.plan,
        lastPrice: price,
      });
      recordAccountEquity(userId, 'live', {
        equity,
        walletBalance: Number(quote.walletBalance) || 0,
        unrealizedPnl: Number(quote.unrealizedPnl) || 0,
        realizedPnl: Number(st0.realizedPnl || 0),
      });
    }
    saveRobot(robotId, patch0);
    recordEquity(robotId, equity, price);
    return;
  }

  /* ---------- 执行动作 ---------- */
  for (const act of result.actions) {
    // 用户点「停止并平仓」时，正在跑的 tick 要立刻收手，不能再按旧计划下单
    if (entry.stopped) break;
    try {
      if (mode === 'paper') {
        if (act.type === 'open') {
          // 全仓语义：多个模拟机器人共用一个账户钱包，
          // 开仓前必须确认「钱包余额 − 所有机器人已占用保证金」还够本层保证金。
          const needMargin = Number(act.notional) / Math.max(1, Number(params.leverage) || 20);
          const avail = availableForUser(userId);
          if (needMargin > avail.available + 1e-9) {
            logEvent(
              userId,
              robotId,
              'warn',
              `开仓被拒：账户可用余额不足。本层需要保证金 ${needMargin.toFixed(4)}U，`
                + `可用 ${avail.available.toFixed(4)}U（钱包 ${avail.balance.toFixed(4)}U − 已占用 ${avail.usedMargin.toFixed(4)}U）`,
            );
            continue;
          }
          const r = exchange.openPosition(book, {
            side: act.side,
            notional: act.notional,
            price,
            leverage: params.leverage,
            layer: act.layer,
            reason: act.reason,
          });
          if (!r.ok) {
            logEvent(userId, robotId, 'warn', `开仓被拒：${r.error}`);
            continue;
          }
          book = r.book;
          recordOrder(userId, robotId, symbol, {
            side: act.side === 'long' ? 'BUY' : 'SELL',
            qty: r.order.qty,
            price: r.order.price,
            fee: r.order.fee,
            reason: act.reason,
            status: 'FILLED',
          });
          logEvent(
            userId,
            robotId,
            'trade',
            `开${act.side === 'long' ? '多' : '空'} 第 ${act.layer} 层：名义 ${act.notional.toFixed(2)}U，`
              + `保证金 ${(act.notional / params.leverage).toFixed(2)}U`,
          );
        } else if (act.type === 'close') {
          // 逐笔止盈时只平指定几笔（closeLegs），整体止盈时整边平（closeSide）
          const useLegs = Array.isArray(act.legIds) && act.legIds.length
            && typeof exchange.closeLegs === 'function';
          const r = useLegs
            ? exchange.closeLegs(book, act.side, price, act.legIds, act.reason)
            : exchange.closeSide(book, act.side, price, act.reason);
          book = r.book;
          if (r.closed) {
            recordOrder(userId, robotId, symbol, {
              side: act.side === 'long' ? 'SELL' : 'BUY',
              qty: r.closed.qty,
              price: r.closed.price,
              fee: r.closed.fee,
              realizedPnl: r.closed.pnl,
              reason: act.reason,
              reduceOnly: true,
              status: 'FILLED',
            });
            logEvent(
              userId,
              robotId,
              r.closed.pnl >= 0 ? 'trade' : 'warn',
              `平${act.side === 'long' ? '多' : '空'}：${act.reason}，`
                + `盈亏 ${r.closed.pnl >= 0 ? '+' : ''}${r.closed.pnl.toFixed(4)}U`,
            );
          }
        }
      } else {
        /* 实盘 */
        // 安全闸：没有显式开启 LIVE_TRADING 时，绝不向真实账户发单
        if (!TRADING.liveEnabled) {
          logEvent(
            userId,
            robotId,
            'warn',
            '实盘下单已被安全闸拦截：服务启动时未设置 LIVE_TRADING=1。'
              + '本次只读取行情与账户，不会向币安发送任何订单。',
          );
          continue;
        }
        const creds = loadCredentials(userId);
        if (!creds) continue;
        if (act.type === 'open') {
          // P0-6：账本为空但交易所已经有这个方向的仓 —— 绝对不能开仓。
          // 否则就重现事故：账本 0、交易所已经有仓，每一 tick 都以为自己是空仓，
          // 反复开第一笔，把交易所真实仓位越推越大。
          const exPos0 = (quote.positions || []).find((x) => x.side === act.side);
          const exQty0 = Number((exPos0 || {}).qty) || 0;
          if (exQty0 > 0 && ownQty(legs, act.side) <= 1e-12) {
            logEvent(
              userId,
              robotId,
              'warn',
              `拒绝开仓：交易所 ${act.side === 'long' ? '多' : '空'}单已有 ${exQty0} 张，`
                + '但机器人账本为空。等下一个 tick 接管完成后再操作。',
            );
            continue;
          }
          const qty = act.notional / price;
          // P0-3：意图序号取「本机器人已记录订单数 + 1」，重启后依然可复现；
          // 同一意图重试得到同一 id（幂等），不同意图必然不同。
          const opSeq = Number((get('SELECT COUNT(*) AS c FROM orders WHERE robot_id = ?', robotId) || {}).c || 0) + 1;
          const opCid = makeClientId(robotId, act.side, act.layer, 'op', opSeq);
          // P0-4：下单前本地查重。这条 clientOrderId 如果已经落库为成交，
          // 说明上一轮其实已经下成、只是没走到 addLeg 就出错了，直接发会把同一笔重复成交。
          const dup = get('SELECT * FROM orders WHERE client_id = ?', opCid);
          if (dup && String(dup.status || '').toUpperCase() === 'FILLED') {
            addLeg(legs, act.side, {
              qty: Number(dup.qty) || 0,
              entryPrice: Number(dup.avg_price || dup.price) || price,
              leverage: Number(params.leverage) || 1,
              layer: act.layer,
              clientId: opCid,
              reason: act.reason,
            });
            logEvent(userId, robotId, 'warn',
              `跳过重复下单：${opCid} 已成交（${dup.qty} 张 @ ${dup.avg_price || dup.price}），已直接补记账本`);
            continue;
          }
          const res = await exchange.placeOrder(creds, {
            symbol,
            side: act.side === 'long' ? 'BUY' : 'SELL',
            positionSide: act.side === 'long' ? 'LONG' : 'SHORT',
            type: 'MARKET',
            quantity: qty,
            price,
            rules,
            clientOrderId: opCid,
          });
          const filledQty = Number(res.executedQty) || qty;
          const avgPrice = Number(res.avgPrice) || price;
          // P0-2：先写账本（内存），再记账（DB）。
          // 上一版先 recordOrder 后 addLeg：recordOrder 抛 UNIQUE 时账本没记上，
          // 交易所却已成交 → 身份丢失 → 重复开仓。顺序颠倒后即使记账失败，
          // 账本也是准的，下一 tick 就能正常接管/平仓。
          addLeg(legs, act.side, {
            qty: filledQty,
            entryPrice: avgPrice,
            leverage: Number(params.leverage) || 1,
            layer: act.layer,
            clientId: res.clientOrderId,
            reason: act.reason,
          });
          recordOrder(userId, robotId, symbol, {
            side: act.side === 'long' ? 'BUY' : 'SELL',
            qty: filledQty,
            price: avgPrice,
            avgPrice,
            clientId: res.clientOrderId,
            reason: act.reason,
            status: res.status || 'FILLED',
          });
          logEvent(
            userId,
            robotId,
            'trade',
            `实盘开${act.side === 'long' ? '多' : '空'} 第 ${act.layer} 层：`
              + `${filledQty} 张 @ ${avgPrice}`,
          );
          clearOrderErrors(robotId);
        } else if (act.type === 'close') {
          // 接管模式下账本 = 交易所该方向全部数量（含接管来的），所以平仓就是全平。
          const myQty = ownQty(legs, act.side);
          if (!(myQty > 0)) {
            logEvent(
              userId,
              robotId,
              'warn',
              `${act.side === 'long' ? '多' : '空'}单账本为空，跳过平仓`,
            );
            continue;
          }
          const exQty = Number(((quote.positions || []).find((x) => x.side === act.side) || {}).qty) || 0;
          const closeQty = Math.min(myQty, exQty > 0 ? exQty : myQty);
          const clSeq = Number((get('SELECT COUNT(*) AS c FROM orders WHERE robot_id = ?', robotId) || {}).c || 0) + 1;
          const res = await exchange.placeOrder(creds, {
            symbol,
            side: act.side === 'long' ? 'SELL' : 'BUY',
            positionSide: act.side === 'long' ? 'LONG' : 'SHORT',
            type: 'MARKET',
            quantity: closeQty,
            price,
            rules,
            reduceOnly: true,
            clientOrderId: makeClientId(robotId, act.side, 0, 'cl', clSeq),
          });
          const filledQty = Number(res.executedQty) || closeQty;
          const avgPrice = Number(res.avgPrice) || price;
          // 币安成交回报里没有 pnl 字段，只能拿「账本均价」和「实际成交价」自己算。
          // drainXXX 会返回被平掉那部分的加权均价（逐笔止盈时比整体均价更准确）。
          const before = ownAvgEntry(legs, act.side);
          const drained = Array.isArray(act.legIds) && act.legIds.length
            ? drainLegs(legs, act.side, act.legIds)
            : drainQty(legs, act.side, filledQty);
          const costBasis = drained.avgEntry > 0 ? drained.avgEntry : before;
          const realizedPnl = costBasis > 0
            ? (act.side === 'long' ? avgPrice - costBasis : costBasis - avgPrice) * filledQty
            : 0;
          liveRealizedDelta += realizedPnl;
          recordOrder(userId, robotId, symbol, {
            side: act.side === 'long' ? 'SELL' : 'BUY',
            qty: filledQty,
            price: avgPrice,
            avgPrice,
            clientId: res.clientOrderId,
            reason: act.reason,
            realizedPnl,
            reduceOnly: true,
            status: res.status || 'FILLED',
          });
          logEvent(
            userId,
            robotId,
            realizedPnl >= 0 ? 'trade' : 'warn',
            `实盘平${act.side === 'long' ? '多' : '空'}：${act.reason}（${filledQty} 张 @ ${avgPrice}，`
              + `盈亏 ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(4)}U）`,
          );
        }
      }
    } catch (e) {
      logEvent(userId, robotId, 'error', `执行 ${act.type} ${act.side} 失败：${(e && e.message) || e}`);
      // P0-5：实盘连续下单错误自动熔断。
      // 事故时 36 次 UNIQUE 异常只写了事件、机器人继续跑 5 秒一拍，越亏越大。
      if (mode === 'live' && act.type !== 'close') markOrderError(entry);
    }
  }

  /* ---------- 实盘保护单：止盈/止损真的挂到币安上（用户问题 #10） ---------- */
  if (mode === 'live' && legs) {
    const creds1 = loadCredentials(userId);
    if (creds1) {
      const stPrev = parseJson(row.state_json, null) || {};
      const sync1 = await syncProtection({
        creds: creds1, robotId, userId, symbol, legs, params, price, equity, rules,
        prevCondOrders: stPrev.condOrders, force: true,
      });
      condNext = sync1.next;
      condWarn = sync1.warn || '';
      // 保护单挂不上是高风险：交易所侧裸仓，只能靠软件止损。必须留 error 级事件。
      if (sync1.severe) {
        logEvent(userId, robotId, 'error', `保护单异常：${sync1.severe}`);
      }
      if (sync1.changed) {
        logEvent(userId, robotId, 'info',
          `实盘止盈止损单已同步：新挂 ${sync1.placed} 个，撤销 ${sync1.canceled} 个`
            + (sync1.failed ? `，${sync1.failed} 个挂单失败` : ''));
      }
    }
  }

  /* ---------- 落库 ---------- */
  const patch = { last_tick: Date.now(), last_error: null };
  if (mode === 'paper') {
    // 账户级钱包：paper.js 只改内存里的 book.walletBalance，这里把现金差额写回 paper_accounts
    const cashDelta = Number(book.walletBalance || 0) - cashBefore;
    const pnlDelta = Number(book.realizedPnl || 0) - pnlBefore;
    const feeDelta = Number(book.feePaid || 0) - feeBefore;
    let cashNow = cashBefore;
    if (cashDelta || pnlDelta || feeDelta) {
      const w = applyWalletDelta(userId, { cashDelta, pnlDelta, feeDelta });
      cashNow = Number(w.balance || 0);
    }
    // book.walletBalance 在内存里已经等于 cashNow（同一笔差额），直接用它算权益
    const eq = exchange.equityOf(book, price);
    recordEquity(robotId, eq, price);
    // 账户级快照：概览页的权益曲线用这条，而不是单机器人曲线
    recordAccountEquity(userId, 'paper', {
      equity: eq,
      walletBalance: cashNow,
      unrealizedPnl: eq - cashNow,
      realizedPnl: Number(book.realizedPnl || 0),
    });
    patch.paper_json = JSON.stringify(splitBook(book));
    const st = parseJson(row.state_json, null) || {};
    patch.state_json = JSON.stringify({
      ...st,
      equity: eq,
      balance: cashNow,
      unrealizedPnl: eq - cashNow,
      realizedPnl: Number(book.realizedPnl || 0),
      initialEquity: Number(wallet && wallet.initialBalance ? wallet.initialBalance : 0),
      positions: {
        long: (book.positions && book.positions.long) || [],
        short: (book.positions && book.positions.short) || [],
      },
      anchorPrice,
      plan: result.plan,
      halted: false,
      lastPrice: price,
    });
  } else {
    const st = parseJson(row.state_json, null) || {};
    // 账本里只保留机器人自己的仓位；手动仓位单独标出来给前端看，机器人不会动
    const ownPositions = (quote.positions || [])
      .map((p) => {
        const q = ownQty(legs, p.side);
        return {
          ...p,
          ownQty: q,
          manualQty: Math.max(0, Number(p.qty) - q),
        };
      })
      .filter((p) => Number(p.ownQty) > 0 || Number(p.manualQty) > 0);
    // 浮动盈亏只算机器人自己那部分，不含用户手动仓（quote.unrealizedPnl 是全账户的）
    const ownUnrealized = ['long', 'short'].reduce((sum, side) => {
      const q = ownQty(legs, side);
      if (!(q > 0)) return sum;
      const a = ownAvgEntry(legs, side);
      return sum + (side === 'long' ? (price - a) * q : (a - price) * q);
    }, 0);
    // 已实现盈亏 = 历史累计 + 本次 tick 平仓产生的增量
    const realized = Number(st.realizedPnl || 0) + liveRealizedDelta;
    patch.state_json = JSON.stringify({
      ...st,
      equity,
      balance: Number(quote.walletBalance) || 0,
      unrealizedPnl: ownUnrealized,
      realizedPnl: realized,
      initialEquity: Number(st.initialEquity || 0) || equity,
      positions: {
        long: ownPositions.filter((x) => x.side === 'long'),
        short: ownPositions.filter((x) => x.side === 'short'),
      },
      liveLegs: legs,
      takeover,
      takeoverNotice: liveNotice || st.takeoverNotice || {},
      condOrders: condNext || normalizeCondOrders(st.condOrders),
      condWarn: condWarn !== '' ? condWarn : (st.condWarn || ''),
      condSyncedAt: condNext ? Date.now() : Number(st.condSyncedAt || 0),
      anchorPrice,
      plan: result.plan,
      halted: false,
      lastPrice: price,
    });
    recordEquity(robotId, equity, price);
    // 账户级快照：实盘的权益曲线也要有数据
    recordAccountEquity(userId, 'live', {
      equity,
      walletBalance: Number(quote.walletBalance) || 0,
      unrealizedPnl: ownUnrealized,
      realizedPnl: realized,
    });
  }
  saveRobot(robotId, patch);
}

/**
 * 实盘规则（带缓存）。
 *
 * live.js 的 getRules 自己会做三层取值：内存缓存 → data/rules-cache.json 磁盘缓存 →
 * 最后的兜底常量（并标 degraded:true）。这里不再另加一层「失败就返回 PAPER_RULES」的
 * 静默降级 —— 那个静默降级就是 -1111 精度错误的帮凶：PAPER_RULES 的 stepSize 固定 0.001，
 * 而 BNBUSDT / 股票类合约真实是 0.01，多写一位小数币安直接拒单。
 */
const liveRulesCache = new Map();
async function getLiveRules(symbol) {
  const hit = liveRulesCache.get(symbol);
  if (hit && Date.now() - hit.at < 600000) return hit.value;
  try {
    const { getRules } = await import('../binance/live.js');
    const r = await getRules(symbol);
    // 兜底规则不缓存，让它下次还能再试着拉真实值
    if (r && !r.degraded) liveRulesCache.set(symbol, { value: r, at: Date.now() });
    return r;
  } catch {
    return PAPER_RULES;
  }
}

const PAPER_RULES = { minQty: 0.001, stepSize: 0.001, tickSize: 0.0001, minNotional: 5, maxLeverage: 125 };

/**
 * 实盘规则降级提示（节流：同一机器人 10 分钟内只提醒一次）。
 */
const degradedNotice = new Map();
function warnDegradedRules(userId, robotId, symbol, rules) {
  if (!rules || !rules.degraded) return;
  const key = `${robotId}:${symbol}`;
  const last = degradedNotice.get(key) || 0;
  if (Date.now() - last < 600000) return;
  degradedNotice.set(key, Date.now());
  logEvent(
    userId,
    robotId,
    'warn',
    `取不到 ${symbol} 的交易所精度规则（${rules.error || '网络异常'}），暂时用兜底精度下单，数量可能被交易所拒绝。-1111 会自动降精度重试。`,
  );
}

/* --- 旧的带时间戳 id 已弃用：换成 live.js 的确定性 makeClientId（防重复下单）--- */
/* ------------------------------------------------------------------ *
 * 实盘保护单（止盈 / 止损）
 * ------------------------------------------------------------------ */

/**
 * 把「应该挂的止盈止损」真正挂到币安上（用户问题 #10：机器人开的仓是裸仓）。
 *
 * 调用时机：
 *   1. 每次 tick 执行完动作之后（force=true，因为仓位变了触发价也得变）；
 *   2. 没有动作的 tick 里每 60 秒对账一次（force=false），确保单子没被手动撤掉。
 *
 * 失败不抛异常：挂单失败只记事件，不能让一个止损单把整个 tick 搞崩。
 */
async function syncProtection(p) {
  const {
    creds, robotId, userId, symbol, legs, params, price, equity, rules, prevCondOrders,
  } = p;
  const prev = normalizeCondOrders(prevCondOrders);
  const out = { next: prev, changed: false, placed: 0, canceled: 0, failed: 0, warn: '' };

  let open = null;
  try {
    // 普通挂单 + Algo 条件单 一起取：保护单现在挂在 Algo 端点上，
    // 只看 /fapi/v1/openOrders 会以为它们都「消失了」，导致每轮撤了重挂。
    open = await fetchAllOpenOrders(creds, symbol);
  } catch (e) {
    // 拿不到挂单列表就什么都不动（宁可多留一条旧单，也不能盲掸）
    out.warn = `读取挂单失败：${(e && e.message) || e}`;
    return out;
  }

  const { orders: desired, skipped } = desiredCondOrders({
    robotId,
    legs,
    params,
    price,
    equity,
    rules,
    fns: { tpTargetFor, stopTargetFor, liqPrice },
  });

  // 交易所返回的挂单里，只认机器人自己挂的（clientOrderId 以 bt 开头）
  const { toCancel, toPlace } = diffCondOrders(prev, desired, open);

  for (const old of toCancel) {
    try {
      await cancelByClientId(creds, symbol, old.id);
      out.canceled += 1;
    } catch {
      /* 已不存在就当作删成功，真失败也只影响一条，下次 tick 再试 */
    }
  }

  const placed = [];
  for (const want of toPlace) {
    try {
      const res = await placeConditional(creds, {
        symbol,
        side: want.side,
        type: want.type,
        triggerPrice: want.triggerPrice,
        quantity: want.quantity,
        rules,
        clientOrderId: want.id,
      });
      if (res) {
        placed.push({
          ...want,
          // Algo 单的订单号字段是 algoId（普通单才是 orderId），两个都取
          orderId: res.algoId || res.orderId || res.order_id || 0,
          algoId: res.algoId || 0,
          placedAt: Date.now(),
        });
        out.placed += 1;
      }
    } catch (e) {
      out.failed += 1;
      out.warn = `挂${want.type === 'tp' ? '止盈' : '止损'}单失败：${(e && e.message) || e}`;
    }
  }

  const canceledIds = new Set(toCancel.map((x) => x.id));
  out.next = [...prev.filter((x) => !canceledIds.has(x.id)), ...placed];
  out.changed = Boolean(out.canceled || out.placed);

  // 保护单挂不上的严重性：事故期间交易所侧真的是一张止损单都没有（只靠 5 秒 tick 的软件止损），
  // 所以挂单失败不能只安静地存在 state_json 里，必须留一条 error 级事件。
  if (out.failed > 0) {
    out.severe = `止盈/止损单有 ${out.failed} 个没挂上：${out.warn}`;
  } else if (desired.length > 0 && placed.length === 0 && out.canceled === 0) {
    // 想挂但一个都没挂成功（通常是精度的 QTY_TOO_SMALL 或名义不足）
    out.severe = out.warn || '';
  }

  // 止盈/止损之间存在方向颠倒等异常时，提醒一次
  if (skipped.length) {
    out.warn = out.warn || skipped[0].reason;
  }

  // 平台算出来应该挂的单数量与最终生效的不一致时（比如部分失败）也提醒
  if (!out.changed && desired.length === 0 && prev.length > 0) {
    out.warn = out.warn || '仓位已平，保护单已全部撤销';
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

/**
 * 启动机器人。若已在运行则先停。
 * @param {object} row robots 表的一行
 */
export async function startRobot(row) {
  if (!row || !row.id) throw new Error('机器人为空');
  await stopRobot(row.id);

  // 老机器人的 params_json 里可能是旧参数名（k/beta/kMax/dMax/stopAtr），
  // 这里统一归一化一次，缺的补默认值、旧的自动映射成新名。
  const params = normalizeParams(parseJson(row.params_json, {}));
  const entry = {
    robotId: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    mode: row.mode,
    params,
    timer: null,
    ticking: false,
    stopped: false,
  };

  // 实盘启动前先把杠杆设成参数里的值。
  // 币安下单不会自动改杠杆，账户里如果是 30x 而我们按 20x 算保证金，仓位会对不上。
  if (row.mode === 'live' && TRADING.liveEnabled) {
    try {
      const creds = loadCredentials(row.user_id);
      if (creds && params.leverage) {
        const { setLeverage } = await import('../binance/live.js');
        const r = await setLeverage(creds, row.symbol, Number(params.leverage));
        logEvent(
          row.user_id,
          row.id,
          'info',
          r && r.noop
            ? `杠杆已是 ${params.leverage}x，无需调整`
            : `已把 ${row.symbol} 杠杆设置为 ${params.leverage}x`,
        );
      }
    } catch (e) {
      logEvent(row.user_id, row.id, 'warn', `设置杠杆失败（继续运行，可能沿用账户当前杠杆）：${(e && e.message) || e}`);
    }
  }

  const intervalMs = TICK.intervalMs;
  entry.timer = setInterval(async () => {
    if (entry.ticking) return;
    entry.ticking = true;
    try {
      await tick(entry);
    } catch (e) {
      console.error('[runner] tick 异常:', (e && e.message) || e);
      logEvent(entry.userId, entry.robotId, 'error', `决策异常：${(e && e.message) || e}`);
    } finally {
      entry.ticking = false;
    }
  }, intervalMs);
  entry.timer.unref?.();

  running.set(row.id, entry);

  // 立刻跑一次，不必等第一个 interval
  entry.ticking = true;
  try {
    await tick(entry);
  } catch (e) {
    logEvent(entry.userId, entry.robotId, 'error', `首次决策异常：${(e && e.message) || e}`);
  } finally {
    entry.ticking = false;
  }
  return entry;
}

/**
 * 停止机器人。
 *
 * @param {string} robotId
 * @param {object} [opts]
 * @param {boolean} [opts.closePositions] 是否先平掉**这个机器人自己账本里的**仓位
 * @returns {Promise<{closed:string[], closedCount:number}>}
 */
export async function stopRobot(robotId, opts = {}) {
  const entry = running.get(robotId);
  const result = { closed: [], closedCount: 0 };

  if (entry) {
    // 标记停止：正在跑的 tick 在动作循环里看到 stopped 就 break，不再按旧计划下单
    entry.stopped = true;
    if (entry.timer) clearInterval(entry.timer);
    running.delete(robotId);

    // 等当前 tick 跑完（最多 15 秒），否则「刚平的仓可能又被旧 tick 开回去」
    const deadline = Date.now() + 15000;
    while (entry.ticking && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  if (!opts.closePositions) return result;

  /* ---------- 平仓：只平机器人自己的账本 ---------- */
  let row = null;
  try {
    row = get('SELECT * FROM robots WHERE id = ?', robotId);
  } catch {
    return result;
  }
  if (!row) return result;
  const params = normalizeParams(parseJson(row.params_json, {}));
  const state = parseJson(row.state_json, null) || {};
  const feed = getMarketFeed();
  const price = feed.getPrice(row.symbol) || 0;

  if (row.mode === 'paper') {
    /* 模拟盘：把 book 里两边仓位都平掉，差额通过钱包反映 */
    try {
      const wallet = getWallet(row.user_id);
      let book = mergeBook(parseJson(row.paper_json, null), wallet);
      const cashBefore = Number(book.walletBalance || 0);
      const pnlBefore = Number(book.realizedPnl || 0);
      const feeBefore = Number(book.feePaid || 0);
      const exchange = getExchange('paper');
      for (const side of ['long', 'short']) {
        const r = exchange.closeSide(book, side, price, '停止机器人时手动平仓');
        if (r && r.ok && r.closed) {
          book = r.book;
          result.closed.push(side);
          recordOrder(row.user_id, robotId, row.symbol, {
            side: side === 'long' ? 'SELL' : 'BUY',
            qty: r.closed.qty,
            price: r.closed.price,
            fee: r.closed.fee,
            realizedPnl: r.closed.pnl,
            reason: '停止机器人时手动平仓',
            reduceOnly: true,
            status: 'FILLED',
          });
        }
      }
      result.closedCount = result.closed.length;
      const cashDelta = Number(book.walletBalance || 0) - cashBefore;
      const pnlDelta = Number(book.realizedPnl || 0) - pnlBefore;
      const feeDelta = Number(book.feePaid || 0) - feeBefore;
      if (cashDelta || pnlDelta || feeDelta) {
        applyWalletDelta(row.user_id, { cashDelta, pnlDelta, feeDelta });
      }
      // state_json 里的 positions / equity 也要一起更新，否则详情页还显示着已经平掉的仓
      const eqAfter = exchange.equityOf(book, price);
      saveRobot(robotId, {
        paper_json: JSON.stringify(splitBook(book)),
        state_json: JSON.stringify({
          ...state,
          equity: eqAfter,
          balance: Number(book.walletBalance || 0),
          unrealizedPnl: eqAfter - Number(book.walletBalance || 0),
          realizedPnl: Number(book.realizedPnl || 0),
          positions: {
            long: (book.positions && book.positions.long) || [],
            short: (book.positions && book.positions.short) || [],
          },
          lastPrice: price,
        }),
      });
      recordAccountEquity(row.user_id, 'paper', {
        equity: eqAfter,
        walletBalance: Number(book.walletBalance || 0),
        unrealizedPnl: eqAfter - Number(book.walletBalance || 0),
        realizedPnl: Number(book.realizedPnl || 0),
      });
      if (result.closedCount) {
        logEvent(row.user_id, robotId, 'trade',
          `停止机器人：已平掉模拟盘 ${result.closed.map((s) => (s === 'long' ? '多' : '空')).join('、')}仓`);
      }
    } catch (e) {
      logEvent(row.user_id, robotId, 'error', `停止时平仓失败：${(e && e.message) || e}`);
    }
    return result;
  }

  /* 实盘：按 liveLegs 的数量下 reduceOnly 市价单，并撤掉自己挂的条件单 */
  const legs = parseLiveLegs(state);
  const creds = loadCredentials(row.user_id);
  if (!creds || !TRADING.liveEnabled) {
    logEvent(row.user_id, robotId, 'warn', '停止时平仓被跳过：缺少 API Key 或未开启实盘下单');
    return result;
  }
  try {
    const rules = await getLiveRules(row.symbol);
    const ex = getExchange('live');
    for (const side of ['long', 'short']) {
      const qty = ownQty(legs, side);
      if (!(qty > 0)) continue;
      // P0-3：停止时平仓也要给序号，否则同一次「停止→启动→再停止」会撞同一个 id。
      const stSeq = Number((get('SELECT COUNT(*) AS c FROM orders WHERE robot_id = ?', robotId) || {}).c || 0) + 1;
      const res = await ex.placeOrder(creds, {
        symbol: row.symbol,
        side: side === 'long' ? 'SELL' : 'BUY',
        positionSide: side === 'long' ? 'LONG' : 'SHORT',
        type: 'MARKET',
        quantity: qty,
        price,
        rules,
        clientOrderId: makeClientId(robotId, side, 999, 'st', stSeq),
      });
      if (res) {
        result.closed.push(side);
        // 先改账本（内存）后记账，与 tick 里的顺序保持一致
        drainQty(legs, side, Number(res.executedQty) || qty);
        recordOrder(row.user_id, robotId, row.symbol, {
          side: side === 'long' ? 'SELL' : 'BUY',
          qty: Number(res.executedQty) || qty,
          price: Number(res.avgPrice) || price,
          avgPrice: Number(res.avgPrice) || price,
          clientId: res.clientOrderId,
          reason: '停止机器人时手动平仓',
          reduceOnly: true,
          status: res.status || 'FILLED',
        });
      }
    }
    result.closedCount = result.closed.length;

    // 仓位没了，自己挂的止盈止损单也得撤，否则会变成反向开仓的幽灵单
    for (const cond of normalizeCondOrders(state.condOrders)) {
      try {
        await cancelByClientId(creds, row.symbol, cond.id);
      } catch {
        /* 已不存在就算了 */
      }
    }
    // 账本清空，保护单记录也清空
    saveRobot(robotId, {
      state_json: JSON.stringify({
        ...state,
        liveLegs: emptyLiveLegs(),
        takeover: emptyTakeover(),
        takeoverNotice: {},
        condOrders: [],
        condWarn: '',
      }),
    });
    clearOrderErrors(robotId);
    if (result.closedCount) {
      logEvent(row.user_id, robotId, 'trade',
        `停止机器人：已平掉实盘 ${result.closed.map((s) => (s === 'long' ? '多' : '空')).join('、')}仓，并撤销了对应的止盈止损单`);
    }
  } catch (e) {
    logEvent(row.user_id, robotId, 'error', `停止时平仓失败：${(e && e.message) || e}`);
  }
  return result;
}

/** 是否在跑 */
export function isRunning(robotId) {
  return running.has(robotId);
}

/** 启动时恢复所有 status='running' 的机器人 */
export async function bootAll() {
  const rows = all("SELECT * FROM robots WHERE status = 'running'");
  for (const row of rows) {
    try {
      await startRobot(row);
      logEvent(row.user_id, row.id, 'info', '服务重启，机器人已恢复运行');
    } catch (e) {
      console.warn(`[runner] 恢复 ${row.id} 失败：${e.message}`);
    }
  }
  return rows.length;
}

/** 优雅退出：只清定时器，不改数据库状态（重启后要恢复） */
export async function shutdownAll() {
  for (const [id, entry] of running) {
    if (entry.timer) clearInterval(entry.timer);
    running.delete(id);
  }
}

export { tick, logEvent, saveRobot, recordOrder, recordEquity, parseJson };
