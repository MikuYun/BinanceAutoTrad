/**
 * 机器人 CRUD 与生命周期路由。
 * 依赖 strategy 层（params/solver/runner）—— 用动态 import 并容错，
 * 保证策略模块没就绪时平台其他功能仍可用。
 */
import { HttpError, ok, requireAuth } from '../http.js';
import { all, get, run } from '../db.js';
import { randomId } from '../crypto.js';
import { TRADING } from '../config.js';
import { getWallet } from '../strategy/wallet.js';
import { normalizeParams as normalizeParamsSync } from '../strategy/params.js';

/* ------------------------------------------------------------------ *
 * 惰性加载策略模块（避免顶层 import 拖垮启动）
 * ------------------------------------------------------------------ */

async function loadParams() {
  try {
    return await import('../strategy/params.js');
  } catch (e) {
    throw new HttpError(503, 'STRATEGY_NOT_READY', `策略参数模块未就绪：${e.message}`);
  }
}

async function loadSolver() {
  try {
    return await import('../strategy/solver.js');
  } catch (e) {
    throw new HttpError(503, 'STRATEGY_NOT_READY', `策略求解模块未就绪：${e.message}`);
  }
}

async function loadMarket() {
  try {
    const mod = await import('../binance/index.js');
    const feed = mod.getMarketFeed();
    _feed = feed;
    return feed;
  } catch {
    return null;
  }
}

/**
 * 取该合约的真实精度规则（tickSize / stepSize / minNotional）。
 *
 * 历史 bug（2026-10-26）：预览与详情页写死了 {stepSize:0.001, tickSize:0.0001}，
 * 而 BNBUSDT / 股票类合约真实 stepSize 是 0.01 —— 预览算出来的数量比交易所允许的
 * 多一位小数，实盘一下单就被 -1111 拒绝。所以这里必须走真实的 exchangeInfo。
 * 拿不到时退回兜底值（页面仍能渲染），并标记 degraded。
 */
const FALLBACK_RULES = {
  minQty: 0.001,
  stepSize: 0.001,
  tickSize: 0.0001,
  minNotional: 5,
  maxNotional: Infinity,
  maxLeverage: 125,
  degraded: true,
};

async function loadRules(symbol) {
  try {
    const { getRules } = await import('../binance/live.js');
    const r = await getRules(symbol);
    if (r && Number(r.stepSize) > 0) return r;
    return FALLBACK_RULES;
  } catch {
    return FALLBACK_RULES;
  }
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 取属于该用户的机器人，否则 404 */
function ownedRobot(userId, robotId) {
  const row = get('SELECT * FROM robots WHERE id = ? AND user_id = ?', robotId, userId);
  if (!row) throw new HttpError(404, 'ROBOT_NOT_FOUND', '机器人不存在');
  return row;
}

function nowTs() {
  return Date.now();
}

let _feed = null;
function getMarketFeedSafe() {
  return _feed || { getPrice: () => 0 };
}
export function bindMarketFeed(feed) {
  _feed = feed;
}

/** 单个机器人的未实现盈亏（只算它自己的仓位） */
function robotUnrealized(book, price) {
  if (!book || !book.positions) return 0;
  let sum = 0;
  for (const side of ['long', 'short']) {
    for (const leg of book.positions[side] || []) {
      const q = Number(leg.qty) || 0;
      const e = Number(leg.entryPrice) || 0;
      sum += side === 'long' ? (price - e) * q : (e - price) * q;
    }
  }
  return sum;
}

/**
 * 新建机器人时的模拟账本初始状态。
 * 注意：现金（余额）属于**账户级钱包**（paper_accounts），不放机器人账本里；
 * 机器人账本只保存自己持有的仓位。
 * 多空双向，同一标的可同时持有多仓与空仓（币安双向持仓模式）。
 */
export function initPaperState() {
  return {
    realizedPnl: 0,
    feePaid: 0,
    positions: { long: [], short: [] },
    lastPrice: 0,
    updatedAt: nowTs(),
  };
}

/** 把数据库行转成前端用对象（不含敏感字段） */
function shapeRobot(row) {
  // 老机器人存的是旧参数名，这里统一换算成新参数名给前端，避免表单显示成默认值
  const params = normalizeParamsSync(parseJson(row.params_json, {}));
  const paper = parseJson(row.paper_json, null);
  const state = parseJson(row.state_json, null);

  // 统计：模拟盘用「账户钱包 + 本机器人未实现盈亏」；实盘用 state 里缓存的快照
  let equity = null;
  let pnlPct = null;
  let totalPnl = null;
  let walletBalance = null;
  // 资金基数 = 分配资金 + 本机器人累计已实现盈亏（用户 m05585 要求）。
  // 这是这个机器人下一笔仓位实际会用的基数，前端要能直接看到。
  let capital = null;
  let allocatedCapital = Number(params.allocatedCapital) || 0;
  let realizedPnl = 0;
  if (row.mode === 'paper') {
    const wallet = getWallet(row.user_id);
    walletBalance = Number(wallet.balance || 0);
    const markPrice = safe(() => getMarketFeedSafe().getPrice(row.symbol), 0)
      || Number((state && state.lastPrice) || 0);
    const upnl = robotUnrealized(paper, markPrice);
    const real = Number((paper && paper.realizedPnl) || 0);
    realizedPnl = real;
    equity = Number((walletBalance + upnl).toFixed(8));
    totalPnl = Number((real + upnl).toFixed(8));
    // 收益率基数用「本机器人自己分配到的资金」，不是整个账户钱包的初始余额
    const base = allocatedCapital > 0 ? allocatedCapital : Number(wallet.initialBalance || 0);
    pnlPct = base > 0 ? Number(((totalPnl / base) * 100).toFixed(4)) : 0;
    capital = Number((base + real).toFixed(8));
  } else if (state && Number.isFinite(Number(state.equity))) {
    equity = Number(state.equity);
    realizedPnl = Number(state.realizedPnl || 0);
    totalPnl = Number(state.realizedPnl || 0) + Number(state.unrealizedPnl || 0);
    const base = allocatedCapital > 0 ? allocatedCapital : Number(state.initialEquity || 0);
    pnlPct = base > 0 ? Number(((totalPnl / base) * 100).toFixed(4)) : 0;
    capital = Number((base + realizedPnl).toFixed(8));
  }

  const orderCount = get('SELECT COUNT(*) AS c FROM orders WHERE robot_id = ?', row.id);
  const posCount = state && state.positions
    ? (state.positions.long || []).length + (state.positions.short || []).length
    : 0;

  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    mode: row.mode,
    status: row.status,
    params,
    createdAt: row.created_at,
    startedAt: row.started_at,
    lastTick: row.last_tick,
    lastError: row.last_error,
    stats: {
      equity,
      walletBalance,
      capital,
      allocatedCapital,
      realizedPnl,
      pnlPct,
      totalPnl,
      orders: Number((orderCount && orderCount.c) || 0),
      positions: posCount,
      halted: Boolean(state && state.halted),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

export default function registerRobots(app) {
  /** 列表 */
  app.get('/api/robots', async (ctx) => {
    const u = requireAuth(ctx);
    const rows = all('SELECT * FROM robots WHERE user_id = ? ORDER BY created_at DESC', u.id);
    return rows.map(shapeRobot);
  });

  /**
   * 查某个交易对在币安账户里的现有持仓（建机器人前用）。
   *
   * 为什么需要这个接口：币安双向持仓模式下 positionRisk 返回的是账户级聚合仓，
   * 程序分不清「机器人开的」和「用户手动开的」。如果用户已经有仓，机器人启动后
   * 会把用户那部分当成「非机器人仓位」忽略，用户就会看到「机器人是小仓、账户是大仓」。
   * 所以建机器人前先告诉用户「这个币你已经有仓了」，让用户选保留还是从零开始。
   */
  app.get('/api/robots/live-position', async (ctx) => {
    const u = requireAuth(ctx);
    const symbol = String((ctx.query && ctx.query.symbol) || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
      throw new HttpError(400, 'BAD_SYMBOL', '交易标的格式不正确');
    }
    const out = { symbol, configured: false, error: null, hasPosition: false, long: null, short: null };
    let creds = null;
    try {
      const mod = await import('../binance/index.js');
      creds = mod.loadCredentials(u.id);
    } catch {
      creds = null;
    }
    if (!creds) {
      out.needKey = true;
      out.error = '未配置可用的 API Key，无法读取币安持仓。';
      return out;
    }
    out.configured = true;
    try {
      const live = await import('../binance/live.js');
      const quote = await live.fetchAccount(creds);
      const list = (quote && quote.positions) || [];
      for (const side of ['long', 'short']) {
        const pos = list.find((p) => p && p.symbol === symbol && p.side === side);
        if (!pos || !(Number(pos.qty) > 0)) continue;
        out[side] = {
          qty: Number(pos.qty),
          entryPrice: Number(pos.entryPrice) || 0,
          unrealizedPnl: Number(pos.unrealizedPnl) || 0,
          leverage: Number(pos.leverage) || 0,
        };
        out.hasPosition = true;
      }
    } catch (e) {
      out.error = `读取币安持仓失败：${(e && e.message) || e}`;
    }
    return out;
  });

  /** 新建前预览计划（不落库） */
  app.post('/api/robots/preview', async (ctx) => {
    const u = requireAuth(ctx);
    const { symbol, mode, params: rawParams, equity: rawEquity, anchorPrice, realizedPnl: rawRealizedPnl } = ctx.body || {};
    if (!symbol) throw new HttpError(400, 'BAD_SYMBOL', '请选择交易标的');

    const paramsMod = await loadParams();
    const solver = await loadSolver();
    const normalized = paramsMod.normalizeParams
      ? paramsMod.normalizeParams(rawParams || {})
      : rawParams || {};

    const feed = await loadMarket();
    // 优先用异步 ATR（真实币安 K 线计算），失败再回退同步缓存/兜底值
    let atrPct = 0.02;
    if (feed) {
      if (typeof feed.atrPctAsync === 'function') {
        atrPct = await safeAsync(() => feed.atrPctAsync(symbol, '1h'), 0.02);
      } else {
        atrPct = safe(() => feed.atrPct(symbol), 0.02);
      }
    }
    const price = feed ? safe(() => feed.getPrice(symbol), 0) : 0;

    // 用真实的交易所规则（stepSize 等），否则预览数量精度会与实盘对不上
    const rules = mode === 'live'
      ? await loadRules(symbol)
      : { minQty: 0.001, stepSize: 0.001, tickSize: 0.0001, minNotional: 5, maxLeverage: 125 };

    // 参数校验必须带上「真实数量规则 + 现价」：否则像 SKHYNIXUSDT 这种
    // minQty=0.01 的标的，第一笔名义明明不够一个最小单位却会被判可行。
    const check = paramsMod.validateParams
      ? paramsMod.validateParams(normalized, {
        minNotional: rules.minNotional,
        minQty: rules.minQty,
        stepSize: rules.stepSize,
        price,
      })
      : { ok: true, errors: [] };
    if (!check.ok) {
      throw new HttpError(400, 'BAD_PARAMS', (check.errors || []).join('；') || '参数不合法');
    }

    // 预览用的权益：优先前端传入；模拟盘读账户钱包余额；没有钱包再用参数兜底
    let equity = Number(rawEquity);
    if (!Number.isFinite(equity) || equity <= 0) {
      if (mode === 'paper') {
        equity = Number(getWallet(u.id).balance || 0);
      }
      if (!Number.isFinite(equity) || equity <= 0) {
        equity = Number(normalized.allocatedCapital) || 100;
      }
    }

    const plan = solver.solvePlan({
      equity,
      atrPct,
      price,
      // 预览也要用到锚点：如果前端传了 anchorPrice（编辑已持仓机器人时沿用），就用它
      anchorPrice: Number(anchorPrice) > 0 ? Number(anchorPrice) : 0,
      params: normalized,
      rules,
      direction: normalized.direction || 'dual',
      // 编辑已有机器人时，它自己赚到的钱已并入资金基数（用户 m05585 要求）。
      // 新建机器人还没交易过，传 0。
      realizedPnl: Number(rawRealizedPnl) || 0,
    });
    const layers = solver.solveLayers ? solver.solveLayers(plan) : [];
    return {
      plan,
      layers,
      inputs: { equity, atrPct, price, symbol, mode: mode || 'paper' },
      params: normalized,
    };
  });

  /** 详情 */
  app.get('/api/robots/:id', async (ctx) => {
    const u = requireAuth(ctx);
    const row = ownedRobot(u.id, ctx.params.id);
    const robot = shapeRobot(row);
    const state = parseJson(row.state_json, null);
    const orders = all(
      'SELECT * FROM orders WHERE robot_id = ? ORDER BY created_at DESC LIMIT 100',
      row.id,
    );
    const events = all(
      'SELECT level, message, ts FROM events WHERE robot_id = ? ORDER BY id DESC LIMIT 100',
      row.id,
    );
    const equityCurve = all(
      'SELECT ts, equity, price FROM equity_curve WHERE robot_id = ? ORDER BY ts ASC LIMIT 500',
      row.id,
    );

    // 实时重算计划（策略模块未就绪则返回 null）
    let plan = null;
    let layers = [];
    try {
      const solver = await loadSolver();
      const feed = await loadMarket();
      // 详情页同样优先用真实 K 线算出的 ATR，避免展示兜底值
      let atrPct = 0.02;
      if (feed) {
        atrPct = typeof feed.atrPctAsync === 'function'
          ? await safeAsync(() => feed.atrPctAsync(row.symbol, '1h'), 0.02)
          : safe(() => feed.atrPct(row.symbol), 0.02);
      }
      const price = feed ? safe(() => feed.getPrice(row.symbol), 0) : 0;
      const paper = parseJson(row.paper_json, null);
      let equity;
      // 机器人自己的累计已实现盈亏：并入资金基数（用户 m05585 要求）
      let realizedPnl = 0;
      if (row.mode === 'paper') {
        equity = Number(getWallet(row.user_id).balance || 0);
        realizedPnl = Number((paper && paper.realizedPnl) || 0);
      } else {
        equity = Number((state && state.equity) || 0) || Number(robot.params.allocatedCapital) || 100;
        realizedPnl = Number((state && state.realizedPnl) || 0);
      }
      plan = solver.solvePlan({
        equity,
        atrPct,
        price,
        // 计划价格锚定（用户问题 #7）：持仓期间沿用上次的锚点，
        // 否则详情页的触发价/均价/止盈止损会跟着实时价一直漂。
        anchorPrice: Number((state && state.anchorPrice) || 0) || 0,
        params: robot.params,
        realizedPnl,
        // 实盘用交易所真实规则；模拟盘保持原有简单规则
        rules: robot.mode === 'live'
          ? await loadRules(row.symbol)
          : { minQty: 0.001, stepSize: 0.001, tickSize: 0.0001, minNotional: 5, maxLeverage: 125 },
        direction: robot.params.direction || 'dual',
      });
      layers = solver.solveLayers ? solver.solveLayers(plan) : [];
    } catch {
      plan = null;
    }

    return {
      robot,
      state,
      plan: plan ? { ...plan, layers } : null,
      orders: orders.map((o) => ({
        id: o.id,
        clientId: o.client_id,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        qty: o.qty,
        price: o.price,
        avgPrice: o.avg_price,
        status: o.status,
        reduceOnly: Boolean(o.reduce_only),
        reason: o.reason,
        fee: o.fee,
        realizedPnl: Number(o.realized_pnl) || 0,
        createdAt: o.created_at,
      })),
      events,
      equityCurve,
    };
  });

  /** 新建 */
  app.post('/api/robots', async (ctx) => {
    const u = requireAuth(ctx);
    const body = ctx.body || {};
    const name = String(body.name || '').trim();
    if (name.length < 1 || name.length > 40) {
      throw new HttpError(400, 'BAD_NAME', '机器人名称需为 1-40 个字符');
    }
    const symbol = String(body.symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
      throw new HttpError(400, 'BAD_SYMBOL', '交易标的格式不正确');
    }
    const mode = body.mode === 'live' ? 'live' : 'paper';

    const paramsMod = await loadParams();
    const params = paramsMod.normalizeParams
      ? paramsMod.normalizeParams(body.params || {})
      : body.params || {};

    // 新建时也要按「真实数量规则 + 现价」校验：否则能建出一个永远开不了仓的机器人
    const rules = mode === 'live'
      ? await loadRules(symbol)
      : { minQty: 0.001, stepSize: 0.001, tickSize: 0.0001, minNotional: 5, maxLeverage: 125 };
    const feed = await loadMarket();
    const price = feed ? safe(() => feed.getPrice(symbol), 0) : 0;
    const check = paramsMod.validateParams
      ? paramsMod.validateParams(params, {
        minNotional: rules.minNotional,
        minQty: rules.minQty,
        stepSize: rules.stepSize,
        price,
      })
      : { ok: true, errors: [] };
    if (!check.ok) {
      throw new HttpError(400, 'BAD_PARAMS', (check.errors || []).join('；') || '参数不合法');
    }

    const countRow = get('SELECT COUNT(*) AS c FROM robots WHERE user_id = ?', u.id);
    if (Number(countRow.c) >= 20) {
      throw new HttpError(400, 'TOO_MANY_ROBOTS', '最多创建 20 个机器人');
    }

    const id = randomId('r');
    const ts = nowTs();
    const paper = mode === 'paper' ? initPaperState() : null;

    // 实盘：处理「该币已有手动仓」的选择。
    //   discard（默认）= 从零开始，不记录任何基准；
    //   keep          = 把创建这一刻的持仓登记成「手动仓基准」，
    //                   机器人对账时先扣掉基准，绝不把用户原有的仓当成自己的仓。
    const manualPolicy = mode === 'live' && body.manualPolicy === 'keep' ? 'keep' : 'discard';
    let stateInit = null;
    let baseline = { long: 0, short: 0, at: 0 };
    if (mode === 'live') {
      if (manualPolicy === 'keep') {
        try {
          const liveBook = await import('../strategy/liveBook.js');
          const idx = await import('../binance/index.js');
          const creds = idx.loadCredentials(u.id);
          if (!creds) {
            throw new HttpError(400, 'NO_API_KEY', '读取现有持仓需要先配置并验证 API Key。');
          }
          const live = await import('../binance/live.js');
          const quote = await live.fetchAccount(creds);
          const only = liveBook.filterBySymbol(quote.positions, symbol);
          baseline = liveBook.snapshotBaseline(only);
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(400, 'LIVE_POSITION_FAILED', `读取现有持仓失败，无法保留手动仓：${(e && e.message) || e}`);
        }
      }
      stateInit = JSON.stringify({ manualPolicy, manualBaseline: baseline });
    }

    run(
      `INSERT INTO robots
       (id, user_id, name, symbol, mode, status, params_json, state_json, paper_json,
        created_at, updated_at, started_at, last_tick, last_error)
       VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      id,
      u.id,
      name,
      symbol,
      mode,
      JSON.stringify(params),
      stateInit,
      paper ? JSON.stringify(paper) : null,
      ts,
      ts,
    );
    if (mode === 'live' && manualPolicy === 'keep') {
      run('INSERT INTO events (user_id, robot_id, level, message, ts) VALUES (?, ?, ?, ?, ?)',
        u.id, id, 'info',
        `已把创建时该交易对已有的持仓登记为「手动仓基准」（多 ${Number(baseline.long || 0)} 张 / 空 ${Number(baseline.short || 0)} 张），机器人不会用它计算交易。`,
        ts);
    }
    return { robot: shapeRobot(get('SELECT * FROM robots WHERE id = ?', id)) };
  });

  /** 修改名称 / 参数 */
  app.patch('/api/robots/:id', async (ctx) => {
    const u = requireAuth(ctx);
    const row = ownedRobot(u.id, ctx.params.id);
    const body = ctx.body || {};
    const fields = [];
    const values = [];

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 1 || name.length > 40) {
        throw new HttpError(400, 'BAD_NAME', '机器人名称需为 1-40 个字符');
      }
      fields.push('name = ?');
      values.push(name);
    }

    if (body.params !== undefined) {
      if (row.status === 'running') {
        throw new HttpError(400, 'ROBOT_RUNNING', '请先停止机器人再修改参数');
      }
      const paramsMod = await loadParams();
      const params = paramsMod.normalizeParams
        ? paramsMod.normalizeParams(body.params || {})
        : body.params || {};
      // 改参数同样按真实数量规则校验，避免存进一个开不了仓的配置
      const rules = row.mode === 'live'
        ? await loadRules(row.symbol)
        : { minQty: 0.001, stepSize: 0.001, tickSize: 0.0001, minNotional: 5, maxLeverage: 125 };
      const feed = await loadMarket();
      const price = feed ? safe(() => feed.getPrice(row.symbol), 0) : 0;
      const check = paramsMod.validateParams
        ? paramsMod.validateParams(params, {
          minNotional: rules.minNotional,
          minQty: rules.minQty,
          stepSize: rules.stepSize,
          price,
        })
        : { ok: true, errors: [] };
      if (!check.ok) {
        throw new HttpError(400, 'BAD_PARAMS', (check.errors || []).join('；') || '参数不合法');
      }
      fields.push('params_json = ?');
      values.push(JSON.stringify(params));
      // 说明：模拟资金已改为账户级钱包（paper_accounts），不再按机器人保存初始资金，
      // 因此这里不再因 initialCapital 变化重建机器人账本（避免误清空已有仓位）。
    }

    if (!fields.length) return { robot: shapeRobot(row) };

    fields.push('updated_at = ?');
    values.push(nowTs());
    values.push(row.id);
    run(`UPDATE robots SET ${fields.join(', ')} WHERE id = ?`, ...values);
    return { robot: shapeRobot(get('SELECT * FROM robots WHERE id = ?', row.id)) };
  });

  /** 启动 */
  app.post('/api/robots/:id/start', async (ctx) => {
    const u = requireAuth(ctx);
    const row = ownedRobot(u.id, ctx.params.id);

    if (row.mode === 'live') {
      if (!TRADING.liveEnabled) {
        throw new HttpError(
          400,
          'LIVE_DISABLED',
          '实盘下单安全闸未开启：服务启动时需设置环境变量 LIVE_TRADING=1 才能启动实盘机器人。'
            + '当前部署只读取行情与账户，不会向币安发单。',
        );
      }
      const key = get('SELECT id FROM api_keys WHERE user_id = ? AND status = ? LIMIT 1', u.id, 'verified');
      if (!key) {
        throw new HttpError(
          400,
          'NO_API_KEY',
          '实盘模式需要先在「API Key」页面配置并验证密钥。未验证前请使用模拟模式。',
        );
      }

      // 用户选「保留手动仓」时，基准要不要在启动时重拍一次？
      // 必须重拍：创建机器人到真正启动可能隔了几分钟甚至几天，仓位早变了。
      // 但只在机器人还没有自己账本时重拍（已有账本重拍会把机器人的仓当成手动仓）。
      const st0 = parseJson(row.state_json, null) || {};
      const legs0 = st0.liveLegs || {};
      const hasOwnLegs = (legs0.long || []).length > 0 || (legs0.short || []).length > 0;
      if (st0.manualPolicy === 'keep' && !hasOwnLegs) {
        try {
          const liveBook = await import('../strategy/liveBook.js');
          const idx = await import('../binance/index.js');
          const creds = idx.loadCredentials(u.id);
          if (!creds) throw new Error('没有可用的 API Key');
          const live = await import('../binance/live.js');
          const quote = await live.fetchAccount(creds);
          const only = liveBook.filterBySymbol(quote.positions, row.symbol);
          const baseline = liveBook.snapshotBaseline(only);
          run('UPDATE robots SET state_json = ?, updated_at = ? WHERE id = ?',
            JSON.stringify({ ...st0, manualBaseline: baseline }), nowTs(), row.id);
          run('INSERT INTO events (user_id, robot_id, level, message, ts) VALUES (?, ?, ?, ?, ?)',
            u.id, row.id, 'info',
            `启动时重新登记手动仓基准：多 ${Number(baseline.long || 0)} 张 / 空 ${Number(baseline.short || 0)} 张（这部分不参与机器人计算）。`,
            nowTs());
        } catch (e) {
          throw new HttpError(400, 'LIVE_POSITION_FAILED', `启动前读取现有持仓失败，无法保留手动仓：${(e && e.message) || e}`);
        }
      }
    }

    let runner;
    try {
      runner = await import('../strategy/runner.js');
    } catch (e) {
      throw new HttpError(503, 'STRATEGY_NOT_READY', `策略运行器未就绪：${e.message}`);
    }

    run(
      'UPDATE robots SET status = ?, started_at = ?, updated_at = ?, last_error = NULL WHERE id = ?',
      'running',
      nowTs(),
      nowTs(),
      row.id,
    );
    run('INSERT INTO events (user_id, robot_id, level, message, ts) VALUES (?, ?, ?, ?, ?)',
      u.id, row.id, 'info', '机器人启动', nowTs());

    const fresh = get('SELECT * FROM robots WHERE id = ?', row.id);
    await runner.startRobot(fresh);
    return { robot: shapeRobot(get('SELECT * FROM robots WHERE id = ?', row.id)) };
  });

  /** 停止（可选先平仓：body { closePositions?: boolean }） */
  app.post('/api/robots/:id/stop', async (ctx) => {
    const u = requireAuth(ctx);
    const row = ownedRobot(u.id, ctx.params.id);
    const closePositions = Boolean(ctx.body && ctx.body.closePositions);
    let closed = [];
    try {
      const runner = await import('../strategy/runner.js');
      const r = await runner.stopRobot(row.id, { closePositions });
      closed = (r && r.closed) || [];
    } catch {
      /* 运行器未就绪时也允许直接改状态 */
    }
    run(
      'UPDATE robots SET status = ?, updated_at = ? WHERE id = ?',
      'stopped',
      nowTs(),
      row.id,
    );
    const closedText = closed.map((s) => (s === 'long' ? '多' : '空')).join('、');
    run('INSERT INTO events (user_id, robot_id, level, message, ts) VALUES (?, ?, ?, ?, ?)',
      u.id,
      row.id,
      'info',
      closed.length ? `机器人已停止，并平掉${closedText}仓` : '机器人已停止',
      nowTs());
    return { robot: shapeRobot(get('SELECT * FROM robots WHERE id = ?', row.id)), closed };
  });

  /** 重置模拟账本 */
  app.post('/api/robots/:id/reset', async (ctx) => {
    const u = requireAuth(ctx);
    const row = ownedRobot(u.id, ctx.params.id);
    if (row.status === 'running') {
      throw new HttpError(400, 'ROBOT_RUNNING', '请先停止机器人再重置');
    }
    try {
      const runner = await import('../strategy/runner.js');
      if (runner.isRunning && runner.isRunning(row.id)) await runner.stopRobot(row.id);
    } catch {
      /* 忽略 */
    }
    run(
      `UPDATE robots SET paper_json = ?, state_json = NULL, status = 'stopped',
       started_at = NULL, last_tick = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
      JSON.stringify(initPaperState()),
      nowTs(),
      row.id,
    );
    run('DELETE FROM orders WHERE robot_id = ?', row.id);
    run('DELETE FROM equity_curve WHERE robot_id = ?', row.id);
    run('INSERT INTO events (user_id, robot_id, level, message, ts) VALUES (?, ?, ?, ?, ?)',
      u.id,
      row.id,
      'info',
      row.mode === 'live'
        ? '已清空机器人自己的持仓账本（重新从 0 层开始）。注意：交易所上的持仓不会被平掉，重启后这些仓位会被当成「手动仓」，机器人不再管理它们。'
        : '已重置模拟账本',
      nowTs());
    return { robot: shapeRobot(get('SELECT * FROM robots WHERE id = ?', row.id)) };
  });

  /** 删除 */
  app.del('/api/robots/:id', async (ctx) => {
    const u = requireAuth(ctx);
    const row = ownedRobot(u.id, ctx.params.id);
    try {
      const runner = await import('../strategy/runner.js');
      if (runner.isRunning && runner.isRunning(row.id)) await runner.stopRobot(row.id);
    } catch {
      /* 忽略 */
    }
    run('DELETE FROM orders WHERE robot_id = ?', row.id);
    run('DELETE FROM equity_curve WHERE robot_id = ?', row.id);
    run('DELETE FROM events WHERE robot_id = ?', row.id);
    run('DELETE FROM robots WHERE id = ?', row.id);
    return {};
  });

  /** 事件流 */
  app.get('/api/robots/:id/events', async (ctx) => {
    const u = requireAuth(ctx);
    const row = ownedRobot(u.id, ctx.params.id);
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 100, 1), 500);
    return all(
      'SELECT level, message, ts FROM events WHERE robot_id = ? ORDER BY id DESC LIMIT ?',
      row.id,
      limit,
    );
  });

  /** 订单流 */
  app.get('/api/robots/:id/orders', async (ctx) => {
    const u = requireAuth(ctx);
    const row = ownedRobot(u.id, ctx.params.id);
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 100, 1), 500);
    return all(
      'SELECT * FROM orders WHERE robot_id = ? ORDER BY created_at DESC LIMIT ?',
      row.id,
      limit,
    );
  });
}

/** 小工具：安全求值 */
function safe(fn, fallback) {
  try {
    const v = fn();
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** 小工具：安全求值（异步） */
async function safeAsync(fn, fallback) {
  try {
    const v = await fn();
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export { shapeRobot, parseJson, ownedRobot };
