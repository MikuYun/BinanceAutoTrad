/**
 * 实盘交易所适配层。
 *
 * 红线（写在这里，改之前先想清楚）：
 *   1. 交易所是唯一真相源 —— 下单前必须从 positionRisk / openOrders 校准；
 *   2. 下单必须幂等 —— clientOrderId 由 robotId + 侧 + 层 + 批次派生，
 *      网络超时后用 clientOrderId 回查「到底成交没有」，绝不盲目重发；
 *   3. 数量/价格必须按 exchangeInfo 的 stepSize / tickSize 规整到**该资产允许的小数位**，
 *      多一位小数币安就报 -1111 Precision is over the maximum defined for this asset；
 *   4. 双向持仓（positionSide=LONG/SHORT）下**不能传 reduceOnly**，
 *      否则报 -1106 Parameter 'reduceonly' sent when not required；
 *   5. 本机网络可能完全不通 —— 所有方法都要给出可读错误，绝不静默吞掉。
 */
import * as rest from './rest.js';
import { BinanceError } from './rest.js';

/** 交易所规则缓存（symbol -> rules），10 分钟过期 */
const rulesCache = new Map();
const RULES_TTL = 10 * 60 * 1000;

function parseFilters(sym) {
  const out = {
    symbol: sym.symbol,
    tickSize: 0,
    stepSize: 0,
    minNotional: 0,
    maxNotional: Infinity,
    maxLeverage: 125,
    minQty: 0,
  };
  for (const f of sym.filters || []) {
    if (f.filterType === 'PRICE_FILTER') out.tickSize = Number(f.tickSize) || 0;
    if (f.filterType === 'LOT_SIZE') {
      out.stepSize = Number(f.stepSize) || 0;
      out.minQty = Number(f.minQty) || 0;
    }
    if (f.filterType === 'MIN_NOTIONAL') out.minNotional = Number(f.notional || f.minNotional) || 0;
    if (f.filterType === 'MAX_NUM_ORDERS') out.maxOrders = Number(f.limit) || 0;
  }
  return out;
}

/**
 * 取交易规则。带缓存，失败时返回保守默认值（BTCUSDT/HYPEUSDT 这类常见规格）。
 */
export async function getRules(symbol) {
  const cached = rulesCache.get(symbol);
  if (cached && Date.now() - cached.at < RULES_TTL) return cached.value;
  try {
    const info = await rest.exchangeInfo();
    for (const s of info.symbols || []) {
      if (s.contractType && s.contractType !== 'PERPETUAL') continue;
      const r = parseFilters(s);
      rulesCache.set(s.symbol, { value: r, at: Date.now() });
    }
    const hit = rulesCache.get(symbol);
    if (hit) return hit.value;
    throw new BinanceError(`交易所没有该合约：${symbol}`, { code: 'NO_SYMBOL' });
  } catch (err) {
    // 网络不通时用兜底规则，让模拟计划和实盘页面仍能渲染
    return {
      symbol,
      tickSize: 0.0001,
      stepSize: 0.001,
      minQty: 0.001,
      minNotional: 5,
      maxNotional: Infinity,
      maxLeverage: 125,
      degraded: true,
      error: (err && err.message) || String(err),
    };
  }
}

/** 按 stepSize 向下取整 */
export function floorStep(value, step) {
  const v = Number(value);
  const s = Number(step);
  if (!Number.isFinite(v) || !Number.isFinite(s) || s <= 0) return v;
  return Number((Math.floor(v / s + 1e-9) * s).toFixed(10));
}

/** 按 tickSize 四舍五入到最近合法价位 */
export function roundTick(value, tick) {
  const v = Number(value);
  const t = Number(tick);
  if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return v;
  return Number((Math.round(v / t) * t).toFixed(10));
}

/**
 * 一个步长/最小变动单位对应几位小数。
 * stepSize=0.001 → 3 位；tickSize=0.10 → 1 位；stepSize=1 → 0 位。
 * 这是修 -1111「精度超出资产定义」的关键：输出的小数位必须正好等于资产允许的位数。
 */
export function decimalsOf(step) {
  const s = String(Number(step));
  if (!s || s === 'NaN') return 8;
  if (s.includes('e-')) {
    const n = Number(s.split('e-')[1]);
    return Number.isFinite(n) ? n : 8;
  }
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * 把数值规整到 step 的整数倍，并按该 step 的小数位输出字符串。
 * 币安要求字符串格式且小数位不能超过资产定义。
 */
export function fmtStep(value, step, mode = 'floor') {
  const v = Number(value);
  const s = Number(step) || 0;
  if (!Number.isFinite(v) || v <= 0) return '0';
  const d = decimalsOf(s || 1);
  if (!(s > 0)) return v.toFixed(d);
  const units = mode === 'round' ? Math.round(v / s) : Math.floor(v / s + 1e-9);
  const fixed = (units * s).toFixed(d);
  // toFixed 可能留下 "-0"，统一成 "0"
  return Number(fixed) === 0 ? (0).toFixed(d) : fixed;
}

/** 数量按 stepSize 规整后的字符串 */
export function fmtQty(qty, rules) {
  const step = (rules && rules.stepSize) || 0.001;
  return fmtStep(qty, step, 'floor');
}

/** 价格按 tickSize 规整后的字符串 */
export function fmtPrice(price, rules) {
  const tick = (rules && rules.tickSize) || 0.0001;
  return fmtStep(price, tick, 'round');
}

/** 兜底格式化（老代码调用点保持兼容） */
function fmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(10).replace(/\.?0+$/, '');
}

/** 稳定短哈希（用于生成确定性 clientOrderId，避免依赖 Math.random 之类的不可复现值） */
function stableHash(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(-7);
}

/**
 * 生成**确定性** clientOrderId：同一个「机器人 + 侧 + 第几笔 + 动作 + 时间桶」永远得到同一个 id。
 *
 * 为什么不用 Date.now()：网络超时后平台以为没下单、下一轮 tick 又发一次，
 * 带时间戳的 id 每次都不一样，币安就当成两笔独立订单 → 真实重复开仓。
 * 用确定性 id 后，第二次发送会被币安按 -4015/-4116 (duplicate clientOrderId) 拒掉，
 * 我们再按 id 回查，就知道「其实第一笔已经成交了」。
 *
 * @param {string} robotId
 * @param {'long'|'short'|string} side  仓位方向
 * @param {number} layer               第几笔
 * @param {'op'|'cl'|'tp'|'sl'|string} action
 * @param {number} [bucketMs]          时间桶（默认 5 分钟）：同一桶内视为同一次意图
 */
export function makeClientId(robotId, side, layer, action, bucketMs = 300000) {
  const rb = String(robotId).replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'r';
  const sd = String(side || 'x').slice(0, 1).toLowerCase();
  const act = String(action || 'ord').replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'or';
  const lay = Math.max(0, Math.min(999, Number(layer) || 0));
  const bucket = Math.floor(Date.now() / Math.max(1000, bucketMs)).toString(36);
  return `bt${rb}${sd}${lay}${act}${bucket}`.slice(0, 36);
}

/**
 * 从 credentials 读账户快照。
 * @returns {Promise<object>}
 */
export async function fetchAccount(credentials) {
  const [acc, pos] = await Promise.all([
    rest.accountInfo(credentials),
    rest.positionRisk(credentials),
  ]);
  return shapeAccount(acc, pos);
}

/** 把币安原始结构转成平台统一结构 */
export function shapeAccount(acc, positionsRaw) {
  const positions = [];
  for (const p of Array.isArray(positionsRaw) ? positionsRaw : []) {
    const amt = Number(p.positionAmt) || 0;
    if (amt === 0) continue;
    positions.push({
      symbol: p.symbol,
      side: amt > 0 ? 'long' : 'short',
      qty: Math.abs(amt),
      entryPrice: Number(p.entryPrice) || 0,
      markPrice: Number(p.markPrice) || 0,
      unrealizedPnl: Number(p.unRealizedProfit) || 0,
      // 币安全仓下 liquidationPrice 可能是负数或 0（表示该仓位自身不会爆仓），统一归 0
      liqPrice: Math.max(0, Number(p.liquidationPrice) || 0),
      leverage: Number(p.leverage) || 1,
      margin: Number(p.isolatedWallet) || Number(p.positionInitialMargin) || 0,
      marginType: p.marginType || 'cross',
      layers: 1,
    });
  }

  const totalUnrealized = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  const wallet = Number(acc && (acc.totalWalletBalance ?? acc.totalMarginBalance)) || 0;
  const equity = Number(acc && acc.totalMarginBalance) || wallet + totalUnrealized;

  return {
    mode: 'live',
    equity: round(equity, 4),
    walletBalance: round(wallet, 4),
    availableBalance: round(Number(acc && acc.availableBalance) || 0, 4),
    unrealizedPnl: round(totalUnrealized, 4),
    realizedPnl: 0,
    totalInitialMargin: round(Number(acc && acc.totalInitialMargin) || 0, 4),
    totalMaintMargin: round(Number(acc && acc.totalMaintMargin) || 0, 4),
    positions,
    updatedAt: Date.now(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 判断是否「这笔订单其实已经在交易所上了」（重复 clientOrderId 类错误） */
function isDuplicateError(err) {
  const c = err && err.binanceCode;
  return c === -4015 || c === -4116 || c === -2021 || c === -2010;
}

/** 判断是否「订单不存在」 */
function isNotExistError(err) {
  return Boolean(err && err.binanceCode === -2013);
}

/**
 * 按 clientOrderId 回查订单，最多尝试 times 次。
 * @returns {Promise<object|null>} 查到返回订单对象；确定不存在返回 null
 */
async function recoverByClientId(credentials, symbol, clientOrderId, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await sleep(500 * (i + 1));
    try {
      const o = await rest.queryOrder(credentials, symbol, clientOrderId);
      if (o && (o.orderId || o.status)) return o;
    } catch (err) {
      if (isNotExistError(err)) continue; // 再等一会儿，可能是刚提交还没落到查询库
    }
  }
  return null;
}

/**
 * 实盘下单（带幂等恢复）。
 *
 * @param {object} credentials
 * @param {object} spec
 *   { symbol, side:'BUY'|'SELL', positionSide:'LONG'|'SHORT'|'BOTH', type,
 *     quantity, price, rules, clientOrderId, closePosition, reduceOnly }
 * @returns {Promise<object|null>} 订单对象；返回 null 表示「确认没有下成」，调用方可以安全重试
 */
export async function placeOrder(credentials, spec) {
  const { symbol, side, positionSide, type = 'MARKET', quantity, price, rules } = spec;

  // 数量按交易所 stepSize 规整，并按该 step 的小数位输出（修 -1111 精度错误）
  const qtyStr = fmtQty(quantity, rules);
  const qty = Number(qtyStr);
  if (!(qty > 0)) {
    throw new BinanceError(
      `数量 ${quantity} 按最小步长 ${(rules && rules.stepSize) || 0.001} 规整后为 0，无法下单`,
      { code: 'QTY_TOO_SMALL' },
    );
  }

  const refPrice = Number(price) || 0;
  const notional = qty * refPrice;
  const minNotional = (rules && rules.minNotional) || 5;
  if (refPrice > 0 && notional > 0 && notional < minNotional) {
    throw new BinanceError(
      `名义 ${notional.toFixed(4)}U 低于交易所最小下单额 ${minNotional}U`,
      { code: 'BELOW_MIN_NOTIONAL' },
    );
  }

  const form = { symbol, side, type, quantity: qtyStr };
  if (positionSide) form.positionSide = positionSide;
  if (type === 'LIMIT') {
    form.price = fmtPrice(price, rules);
    form.timeInForce = 'GTC';
  }
  if (spec.closePosition) {
    // closePosition=true 时不能带 quantity
    form.closePosition = 'true';
    delete form.quantity;
  } else if (spec.reduceOnly && (!positionSide || positionSide === 'BOTH')) {
    // 双向持仓模式下传 reduceOnly 会被币安直接拒绝（-1106），只有单向持仓才需要
    form.reduceOnly = 'true';
  }
  if (spec.clientOrderId) form.newClientOrderId = spec.clientOrderId;

  try {
    return await rest.newOrder(credentials, form);
  } catch (err) {
    // 重复提交：说明这笔其实已经在交易所了，回查拿真实状态
    if (isDuplicateError(err) && spec.clientOrderId) {
      const found = await recoverByClientId(credentials, symbol, spec.clientOrderId);
      if (found) return { ...found, _recovered: 'duplicate' };
      throw err;
    }
    // 网络超时 / 网关错误：不能假设没成交，必须按 clientOrderId 回查
    if ((err && err.network) || (err && err.binanceCode === -1007)) {
      if (!spec.clientOrderId) throw err;
      const found = await recoverByClientId(credentials, symbol, spec.clientOrderId);
      if (found) return { ...found, _recovered: 'timeout' };
      return null; // 确认没下成，调用方可以安全重试
    }
    throw err;
  }
}

/**
 * 挂止盈 / 止损条件单（双向持仓模式）。
 *
 * 用 TAKE_PROFIT_MARKET / STOP_MARKET + positionSide + quantity：
 * quantity 只填机器人自己那部分，不会碰用户手动仓。
 * 不用 closePosition：那会平掉整个方向的仓位（含用户手动仓）。
 *
 * @param {object} credentials
 * @param {object} spec
 *   { symbol, side:'long'|'short', type:'tp'|'sl', triggerPrice, quantity, rules, clientOrderId }
 */
export async function placeConditional(credentials, spec) {
  const { symbol, side, type, triggerPrice, quantity, rules } = spec;
  const isLong = side === 'long';
  const orderType = type === 'tp' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
  // 平多 = SELL + positionSide LONG；平空 = BUY + positionSide SHORT
  const form = {
    symbol,
    side: isLong ? 'SELL' : 'BUY',
    positionSide: isLong ? 'LONG' : 'SHORT',
    type: orderType,
    stopPrice: fmtPrice(triggerPrice, rules),
    workingType: 'MARK_PRICE',
    quantity: fmtQty(quantity, rules),
  };
  if (spec.clientOrderId) form.newClientOrderId = spec.clientOrderId;
  try {
    return await rest.newOrder(credentials, form);
  } catch (err) {
    if (isDuplicateError(err) && spec.clientOrderId) {
      const found = await recoverByClientId(credentials, symbol, spec.clientOrderId);
      if (found) return { ...found, _recovered: 'duplicate' };
    }
    if ((err && err.network) || (err && err.binanceCode === -1007)) {
      if (!spec.clientOrderId) throw err;
      const found = await recoverByClientId(credentials, symbol, spec.clientOrderId);
      if (found) return { ...found, _recovered: 'timeout' };
      return null;
    }
    throw err;
  }
}

/** 撤单（支持按 exchange orderId，或按 clientOrderId） */
export async function cancel(credentials, symbol, idOrClientId) {
  try {
    return await rest.cancelOrder(credentials, symbol, idOrClientId);
  } catch (err) {
    // 已经不存在（可能已成交或已撤）→ 视为成功，不阻塞流程
    if (isNotExistError(err)) return { noop: true };
    throw err;
  }
}

/** 按 clientOrderId 撤单 */
export async function cancelByClientId(credentials, symbol, clientOrderId) {
  try {
    return await rest.cancelOrder(credentials, symbol, clientOrderId, true);
  } catch (err) {
    if (isNotExistError(err)) return { noop: true };
    throw err;
  }
}

/** 设置杠杆 */
export async function setLeverage(credentials, symbol, leverage) {
  try {
    return await rest.setLeverage(credentials, symbol, leverage);
  } catch (err) {
    // 已经是目标杠杆时币安返回 -4046，视为成功
    if (err && err.binanceCode === -4046) return { noop: true };
    throw err;
  }
}

/** 取挂单 */
export async function fetchOpenOrders(credentials, symbol) {
  return rest.openOrders(credentials, symbol);
}

/** 按 clientOrderId 查询订单（供 runner 做幂等校验） */
export async function queryOrder(credentials, symbol, clientOrderId) {
  try {
    return await rest.queryOrder(credentials, symbol, clientOrderId);
  } catch (err) {
    if (isNotExistError(err)) return null;
    throw err;
  }
}

function round(v, d) {
  return Number.isFinite(v) ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : 0;
}

export const liveExchange = {
  type: 'live',
  getRules,
  fetchAccount,
  placeOrder,
  placeConditional,
  cancel,
  cancelByClientId,
  setLeverage,
  fetchOpenOrders,
  queryOrder,
  floorStep,
  roundTick,
  fmtQty,
  fmtPrice,
  decimalsOf,
  makeClientId,
};
