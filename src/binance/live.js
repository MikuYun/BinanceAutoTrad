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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as rest from './rest.js';
import { BinanceError } from './rest.js';
import { DATA_DIR } from '../config.js';

/** 交易所规则缓存（symbol -> rules），10 分钟过期 */
const rulesCache = new Map();
const RULES_TTL = 10 * 60 * 1000;
/** 落盘缓存：服务重启 + 币安暂时不通时，仍能用上次拉到的真实精度规则，避免退回兜底值再撞 -1111 */
const RULES_DISK = join(DATA_DIR, 'rules-cache.json');
let diskLoaded = false;

/** 完全取不到规则时的保守兜底（会被 precisionAttempts 的降精度重试兜住） */
const HARDCODED_RULES = {
  tickSize: 0.0001,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
  maxNotional: Infinity,
  maxLeverage: 125,
};

/**
 * 这个合约能不能交易。
 *
 * 历史 bug（2026-10-26，用户报 -1111 Precision is over the maximum defined for this asset）：
 * 这里原来写的是「contractType 不是 PERPETUAL 就跳过」，但币安现在把股票 / 商品类合约
 * 标成 TRADIFI_PERPETUAL（SKHYNIXUSDT、XAUUSDT、TSLAUSDT、SPCXUSDT…）。
 * 于是这些标的被排除在 exchangeInfo 解析之外 → getRules 抛 NO_SYMBOL → 静默降级成兜底规则
 * （stepSize 固定 0.001，3 位小数）→ 而它们真实 stepSize 是 0.01（2 位小数）
 * → 下单数量多写一位小数 → 币安直接拒绝 -1111。
 * 现在只排除有交割日的合约（CURRENT_QUARTER / NEXT_QUARTER），其余交易中的全部收录。
 */
export function isTradableSymbol(sym) {
  const ct = String((sym && sym.contractType) || '').toUpperCase();
  if (ct.includes('QUARTER') || ct === 'CURRENT' || ct === 'NEXT') return false;
  const st = String((sym && sym.status) || 'TRADING').toUpperCase();
  return st === 'TRADING';
}

/**
 * 解析单个合约的过滤器。
 *
 * 必须同时看 LOT_SIZE 和 MARKET_LOT_SIZE：限价单按 LOT_SIZE 校验数量精度，
 * 市价单按 MARKET_LOT_SIZE 校验，本平台开仓 / 平仓都用 MARKET，
 * 两者步长不一致时取更粗的一档才能保证两种单都合法。
 */
export function parseFilters(sym) {
  const out = {
    symbol: sym.symbol,
    tickSize: 0,
    stepSize: 0,
    marketStepSize: 0,
    minNotional: 0,
    maxNotional: Infinity,
    maxLeverage: 125,
    minQty: 0,
    contractType: String(sym.contractType || ''),
  };
  for (const f of sym.filters || []) {
    if (f.filterType === 'PRICE_FILTER') out.tickSize = Number(f.tickSize) || 0;
    if (f.filterType === 'LOT_SIZE') {
      out.stepSize = Number(f.stepSize) || 0;
      out.minQty = Math.max(out.minQty, Number(f.minQty) || 0);
    }
    if (f.filterType === 'MARKET_LOT_SIZE') {
      out.marketStepSize = Number(f.stepSize) || 0;
      out.minQty = Math.max(out.minQty, Number(f.minQty) || 0);
    }
    if (f.filterType === 'MIN_NOTIONAL') out.minNotional = Number(f.notional || f.minNotional) || 0;
    if (f.filterType === 'MAX_NUM_ORDERS') out.maxOrders = Number(f.limit) || 0;
  }
  out.stepSize = Math.max(out.stepSize, out.marketStepSize);
  return out;
}

/** 从磁盘恢复规则缓存（只恢复有真实 stepSize 的条目） */
function loadRulesDisk() {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const data = JSON.parse(readFileSync(RULES_DISK, 'utf8'));
    const at = Number(data && data.savedAt) || 0;
    for (const [symbol, value] of Object.entries((data && data.rules) || {})) {
      if (!value || !(Number(value.stepSize) > 0)) continue;
      if (!rulesCache.has(symbol)) rulesCache.set(symbol, { value, at });
    }
  } catch {
    // 没有缓存文件是正常情况（首次启动）
  }
}

/** 把规则缓存写盘（失败不影响交易） */
function saveRulesDisk() {
  try {
    const rules = {};
    for (const [symbol, item] of rulesCache) rules[symbol] = item.value;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(RULES_DISK, JSON.stringify({ savedAt: Date.now(), rules }), { mode: 0o600 });
  } catch {
    // 磁盘写失败只是少了重启兜底，不影响本次运行
  }
}

/**
 * 取交易规则。
 *
 * 取值顺序：内存缓存 → 磁盘缓存 → 兜底常量。
 * 兜底时返回 degraded:true，让上层能在事件里提示用户「现在用的是兜底精度」，
 * 同时下单层还有 precisionAttempts 逐级降精度重试作为最后一道保险。
 */
export async function getRules(symbol) {
  loadRulesDisk();
  const cached = rulesCache.get(symbol);
  if (cached && Date.now() - cached.at < RULES_TTL) return cached.value;
  try {
    const info = await rest.exchangeInfo();
    for (const s of info.symbols || []) {
      if (!isTradableSymbol(s)) continue;
      const r = parseFilters(s);
      rulesCache.set(s.symbol, { value: r, at: Date.now() });
    }
    const hit = rulesCache.get(symbol);
    if (hit) {
      saveRulesDisk();
      return hit.value;
    }
    throw new BinanceError(`交易所没有该合约：${symbol}`, { code: 'NO_SYMBOL' });
  } catch (err) {
    // 拉不到新规则时，优先用缓存里的真实规则（过期也照用），绝不再退回 0.001 兜底去撞 -1111
    if (cached && Number(cached.value.stepSize) > 0) return { ...cached.value, stale: true };
    const fromDisk = rulesCache.get(symbol);
    if (fromDisk && Number(fromDisk.value.stepSize) > 0) {
      return { ...fromDisk.value, stale: true, error: (err && err.message) || String(err) };
    }
    return {
      ...HARDCODED_RULES,
      symbol,
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

/**
 * 数量候选串：第 0 档用真实 stepSize，之后每档把 step 放大 10 倍（小数位少 1 位），最多 4 档。
 *
 * 币安对「数量小数位超过该资产 stepSize」的订单直接拒绝（-1111），
 * 被拒的订单根本没进撮合，所以放宽小数位后重发是安全的，不会造成重复开仓。
 */
export function qtyCandidates(qty, rules, refPrice = 0, minNotional = 0) {
  const step = Number((rules && rules.stepSize) || 0) || 0.001;
  const out = [];
  let s = step;
  for (let i = 0; i < 4; i += 1) {
    const str = fmtStep(qty, s, 'floor');
    const n = Number(str);
    if (n > 0 && !out.includes(str)) {
      // 更粗的 step 只会让数量更小，名义如果已经不够最小下单额，后面的档位更不可能过
      if (minNotional > 0 && refPrice > 0 && n * refPrice < minNotional * 0.999999) break;
      out.push(str);
    }
    s *= 10;
  }
  return out;
}

/**
 * 条件单（止盈 / 止损）的精度候选：数量降精度 + 触发价 tick 放宽，同步逐档尝试。
 */
export function precisionAttempts(rules, { qty, triggerPrice } = {}) {
  const step = Number((rules && rules.stepSize) || 0) || 0.001;
  const tick = Number((rules && rules.tickSize) || 0) || 0.0001;
  const out = [];
  for (let i = 0; i < 4; i += 1) {
    const quantity = qty == null ? null : fmtStep(qty, step * 10 ** i, 'floor');
    const stopPrice = triggerPrice == null ? null : fmtStep(triggerPrice, tick * 10 ** i, 'round');
    if (quantity != null && !(Number(quantity) > 0)) continue;
    const key = `${quantity}|${stopPrice}`;
    if (!out.some((x) => `${x.quantity}|${x.stopPrice}` === key)) out.push({ quantity, stopPrice });
  }
  return out;
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
 * 生成**确定性** clientOrderId：同一个「机器人 + 侧 + 第几笔 + 动作 + 意图序号」永远得到同一个 id。
 *
 * 为什么不用 Date.now()：网络超时后平台以为没下单、下一轮 tick 又发一次，
 * 带时间戳的 id 每次都不一样，币安就当成两笔独立订单 → 真实重复开仓。
 * 用确定性 id 后，第二次发送会被币安按 -4015/-4116 (duplicate clientOrderId) 拒掉，
 * 我们再按 id 回查，就知道「其实第一笔已经成交了」。
 *
 * 历史教训（docs/BUGFIX-PLAN-client-order-id-unique.md）：
 *   上一版把「5 分钟时间桶」当成意图序号，同一桶内二次开仓得到**完全相同**的 id：
 *   第一次成交后 recordOrder 抛 UNIQUE 异常、账本没记上，下一 tick 又发同一笔 →
 *   币安把已成交的市价单再当新单成交，交易所真实持仓越加越大、账本一直是 0。
 *   所以序号必须由调用方按「每次真实意图」递增，不能随时间循环。
 *
 * @param {string} robotId
 * @param {'long'|'short'|string} side  仓位方向
 * @param {number} layer               第几笔
 * @param {'op'|'cl'|'tp'|'sl'|string} action
 * @param {number|string} [seq]        意图序号（同一意图重试传同一个值，不同意图必须不同）
 */
export function makeClientId(robotId, side, layer, action, seq) {
  const rb = String(robotId).replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'r';
  const sd = String(side || 'x').slice(0, 1).toLowerCase();
  const act = String(action || 'ord').replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'or';
  const lay = Math.max(0, Math.min(999, Number(layer) || 0));
  const n = Number(seq);
  const sq = Number.isFinite(n) && n >= 0
    ? n.toString(36)
    : stableHash(String(seq == null ? '' : seq)).slice(-5);
  return `bt${rb}${sd}${lay}${act}${sq}`.slice(0, 36);
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

/** 判断是否「精度超限」（-1111 / -4164）——这类错误说明订单根本没被接受，可以降精度后重发 */
function isPrecisionError(err) {
  const c = err && err.binanceCode;
  if (c === -1111 || c === -4164) return true;
  const msg = String((err && err.message) || '');
  return /precision is over the maximum|too many decimal places/i.test(msg);
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
 * 按 clientAlgoId 回查 Algo 条件单（下单超时/重复 id 时用）。
 * 注意：Algo 单的订单号字段是 algoId（不是 orderId）、状态字段是 algoStatus。
 */
async function recoverAlgoByClientId(credentials, symbol, clientAlgoId, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await sleep(500 * (i + 1));
    try {
      const o = await rest.queryAlgoOrder(credentials, { clientAlgoId });
      if (o && (o.algoId || o.algoStatus)) return o;
    } catch (err) {
      if (isNotExistError(err)) continue;
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

  const refPrice = Number(price) || 0;
  const minNotional = (rules && rules.minNotional) || 5;

  // 数量备选串：第 1 个用真实 stepSize，后面每档小数位少 1 位。
  // 只用于撞上 -1111 时降精度重发（订单未被接受，重发安全）。
  // closePosition=true 时订单不带 quantity，降精度没有意义，只发一次。
  const qtyList = spec.closePosition
    ? [null]
    : qtyCandidates(quantity, rules, refPrice, minNotional);
  if (!qtyList.length) {
    throw new BinanceError(
      `数量 ${quantity} 按最小步长 ${(rules && rules.stepSize) || 0.001} 规整后为 0，无法下单`,
      { code: 'QTY_TOO_SMALL' },
    );
  }

  if (!spec.closePosition) {
    const baseQty = Number(qtyList[0]);
    const notional = baseQty * refPrice;
    if (refPrice > 0 && notional > 0 && notional < minNotional) {
      throw new BinanceError(
        `名义 ${notional.toFixed(4)}U 低于交易所最小下单额 ${minNotional}U`,
        { code: 'BELOW_MIN_NOTIONAL' },
      );
    }
  }

  let lastPrecisionErr = null;
  for (const qtyStr of qtyList) {
    const form = { symbol, side, type };
    if (qtyStr != null) form.quantity = qtyStr;
    if (positionSide) form.positionSide = positionSide;
    if (type === 'LIMIT') {
      form.price = fmtPrice(price, rules);
      form.timeInForce = 'GTC';
    }
    if (spec.closePosition) {
      // closePosition=true 时不能带 quantity
      form.closePosition = 'true';
    } else if (spec.reduceOnly && (!positionSide || positionSide === 'BOTH')) {
      // 双向持仓模式下传 reduceOnly 会被币安直接拒绝（-1106），只有单向持仓才需要
      form.reduceOnly = 'true';
    }
    if (spec.clientOrderId) form.newClientOrderId = spec.clientOrderId;

    try {
      return await rest.newOrder(credentials, form);
    } catch (err) {
      // 精度超限：换一个更粗的数量重发（币安未接受此单，不会重复开仓）
      if (isPrecisionError(err)) {
        lastPrecisionErr = err;
        continue;
      }
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
  throw lastPrecisionErr || new BinanceError('下单失败：精度调整后仍被拒绝', { code: 'PRECISION_FAILED' });
}

/**
 * 挂止盈 / 止损条件单（双向持仓模式）。
 *
 * 走的是 Algo Order 端点（`POST /fapi/v1/algoOrder`，algoType=CONDITIONAL）。
 *
 * 为什么不能用 `/fapi/v1/order`：币安已经对 STOP_MARKET / TAKE_PROFIT_MARKET 关闭了那个端点，
 * 返回 `Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.`
 * 结果就是实盘机器人交易所侧一张止损单都没有（只能靠 5 秒 tick 的软件止损，
 * 行情跳空/断网时等于裸仓）。字段名也不一样：triggerPrice（不是 stopPrice）、
 * clientAlgoId（不是 newClientOrderId）。
 *
 * 用 TAKE_PROFIT_MARKET / STOP_MARKET + positionSide + quantity：
 * 从不使用 closePosition（那会平掉整个方向的仓位）。
 *
 * @param {object} credentials
 * @param {object} spec
 *   { symbol, side:'long'|'short', type:'tp'|'sl', triggerPrice, quantity, rules, clientOrderId }
 */
export async function placeConditional(credentials, spec) {
  const { symbol, side, type, triggerPrice, quantity, rules } = spec;
  const isLong = side === 'long';
  const orderType = type === 'tp' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';

  // 数量 + 触发价双降精度档位：撞 -1111 时逐档退，直到币安接受
  const attempts = precisionAttempts(rules, { qty: quantity, triggerPrice });
  if (!attempts.length) {
    throw new BinanceError(
      `条件单数量 ${quantity} 按最小步长 ${(rules && rules.stepSize) || 0.001} 规整后为 0，无法下单`,
      { code: 'QTY_TOO_SMALL' },
    );
  }

  let lastPrecisionErr = null;
  for (const attempt of attempts) {
    // 平多 = SELL + positionSide LONG；平空 = BUY + positionSide SHORT
    const form = {
      algoType: 'CONDITIONAL',
      symbol,
      side: isLong ? 'SELL' : 'BUY',
      positionSide: isLong ? 'LONG' : 'SHORT',
      type: orderType,
      triggerPrice: attempt.stopPrice,
      workingType: 'MARK_PRICE',
      quantity: attempt.quantity,
    };
    if (spec.clientOrderId) form.clientAlgoId = spec.clientOrderId;
    try {
      return await rest.newAlgoOrder(credentials, form);
    } catch (err) {
      if (isPrecisionError(err)) {
        lastPrecisionErr = err;
        continue;
      }
      if (isDuplicateError(err) && spec.clientOrderId) {
        const found = await recoverAlgoByClientId(credentials, symbol, spec.clientOrderId);
        if (found) return { ...found, _recovered: 'duplicate' };
      }
      if ((err && err.network) || (err && err.binanceCode === -1007)) {
        if (!spec.clientOrderId) throw err;
        const found = await recoverAlgoByClientId(credentials, symbol, spec.clientOrderId);
        if (found) return { ...found, _recovered: 'timeout' };
        return null;
      }
      throw err;
    }
  }
  throw lastPrecisionErr || new BinanceError('条件单挂单失败：精度调整后仍被拒绝', { code: 'PRECISION_FAILED' });
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

/** 按 clientOrderId 撤单（普通单先试，再试 Algo 条件单） */
export async function cancelByClientId(credentials, symbol, clientOrderId) {
  try {
    return await rest.cancelOrder(credentials, symbol, clientOrderId, true);
  } catch (err) {
    if (isNotExistError(err)) {
      // 普通单端点说没这张单 → 可能是 Algo 条件单（保护单现在挂在 Algo 端点上）
      try {
        return await rest.cancelAlgoOrder(credentials, { clientAlgoId: clientOrderId });
      } catch (err2) {
        if (isNotExistError(err2)) return { noop: true };
        throw err2;
      }
    }
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

/** 取挂单（普通单） */
export async function fetchOpenOrders(credentials, symbol) {
  return rest.openOrders(credentials, symbol);
}

/**
 * 取「所有」挂单，普通单 + Algo 条件单合并。
 *
 * 为什么要合并：止盈/止损现在走 Algo 端点，不在 /fapi/v1/openOrders 里。
 * syncProtection 靠这个列表判断「我挂的还在不在」，不合并就会把每张保护单
 * 都当成「已消失」→ 每轮都撤销重挂（白烧流量，还会反复短时无保护）。
 */
export async function fetchAllOpenOrders(credentials, symbol) {
  const out = [];
  try {
    const normal = await rest.openOrders(credentials, symbol);
    if (Array.isArray(normal)) out.push(...normal);
  } catch {
    /* 下面 algo 也一样，一个失败不影响另一个 */
  }
  try {
    const algo = await rest.openAlgoOrders(credentials, symbol);
    const list = Array.isArray(algo) ? algo : (Array.isArray(algo && algo.orders) ? algo.orders : []);
    for (const o of list) {
      out.push({
        ...o,
        // 统一成普通单的字段名，让 diffCondOrders 能用同一套逻辑
        clientOrderId: o.clientAlgoId || o.clientOrderId || '',
        orderId: o.algoId || o.orderId || 0,
        status: o.algoStatus || o.status || '',
        _algo: true,
      });
    }
  } catch {
    /* ignore */
  }
  return out;
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
  fetchAllOpenOrders,
  queryOrder,
  floorStep,
  roundTick,
  fmtQty,
  fmtPrice,
  decimalsOf,
  makeClientId,
};
