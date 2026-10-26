/**
 * 实盘「止盈/止损」识别：以币安上的真实挂单为准，不自己乱估。
 *
 * 背景：用户自己手动在币安开了仓、并且手动挂了止盈止损，
 * 平台的持仓列表必须显示**币安上真实存在的那几个价**，
 * 而不是用默认参数算出来的估算值（估出来的数跟他实际挂的根本不是一回事）。
 *
 * 币安条件单的形态（/fapi/v1/openOrders）：
 *   { symbol, side: 'BUY'|'SELL', positionSide: 'LONG'|'SHORT'|'BOTH',
 *     type: 'TAKE_PROFIT'|'TAKE_PROFIT_MARKET'|'STOP'|'STOP_MARKET'|'LIMIT'...,
 *     stopPrice: '80.50000', price, reduceOnly, closePosition, workingType }
 *
 * 对多仓：止盈/止损都是 SELL，且 reduceOnly 或 closePosition 为 true
 * 对空仓：都是 BUY
 */

/** 是否为条件单里的止盈类型 */
function isTpType(t) {
  const s = String(t || '').toUpperCase();
  return s === 'TAKE_PROFIT' || s === 'TAKE_PROFIT_MARKET';
}

/** 是否为条件单里的止损类型 */
function isSlType(t) {
  const s = String(t || '').toUpperCase();
  return s === 'STOP' || s === 'STOP_MARKET';
}

/** 这条挂单是否属于这个方向的平仓单 */
function belongsToPosition(o, side) {
  const posSide = String(o.positionSide || 'BOTH').toUpperCase();
  if (posSide === 'LONG') return side === 'long';
  if (posSide === 'SHORT') return side === 'short';
  // 单向持仓模式（positionSide=BOTH）：多仓的平仓单是 SELL
  const closeSide = side === 'long' ? 'SELL' : 'BUY';
  return String(o.side || '').toUpperCase() === closeSide;
}

/**
 * 从币安挂单里挑出某个持仓的止盈价与止损价。
 *
 * @param {Array} orders  /fapi/v1/openOrders 的原始数组
 * @param {object} target
 * @param {string} target.symbol
 * @param {'long'|'short'} target.side
 * @param {number} [target.markPrice] 用于挑「最近的一个」（有多个止盈单时）
 * @returns {{
 *   tpPrice: number, stopPrice: number,
 *   tpPrices: number[], stopPrices: number[],
 *   tpCount: number, stopCount: number,
 *   source: 'order'|'none',
 *   tpDetail: Array, stopDetail: Array
 * }}
 */
export function protectionFromOrders(orders, target) {
  const empty = {
    tpPrice: 0,
    stopPrice: 0,
    tpPrices: [],
    stopPrices: [],
    tpCount: 0,
    stopCount: 0,
    source: 'none',
    tpDetail: [],
    stopDetail: [],
  };
  if (!Array.isArray(orders) || !target) return empty;

  const symbol = String(target.symbol || '');
  const side = target.side === 'short' ? 'short' : 'long';
  const mark = Number(target.markPrice) || 0;

  const tps = [];
  const sls = [];
  for (const o of orders) {
    if (String(o.symbol || '') !== symbol) continue;
    const price = Number(o.stopPrice);
    if (!(price > 0)) continue;
    if (!belongsToPosition(o, side)) continue;

    // 只认真正带 reduceOnly / closePosition 的条件单，避免把普通限价挂单看成止盈
    const reducing = Boolean(o.reduceOnly) || Boolean(o.closePosition)
      || String(o.type || '').toUpperCase().endsWith('_MARKET');
    if (!reducing) continue;

    const item = {
      orderId: o.orderId,
      type: String(o.type || ''),
      price,
      qty: Number(o.origQty || o.quantity) || 0,
      closePosition: Boolean(o.closePosition),
      workingType: o.workingType || '',
    };
    if (isTpType(item.type)) tps.push(item);
    else if (isSlType(item.type)) sls.push(item);
  }

  // 有多个时，挑「离当前价最近的那个」作为主显示价（真实最可能先触发的那一单）
  const nearest = (list, dir) => {
    if (!list.length) return 0;
    if (!(mark > 0)) return list[0].price;
    const sorted = [...list].sort((a, b) => Math.abs(a.price - mark) - Math.abs(b.price - mark));
    return sorted[0].price;
  };
  // 方向语义上更严谨的兜底：多头止盈在现价之上、止损在现价之下
  const pickBySide = (list, kind) => {
    if (!list.length) return 0;
    if (!(mark > 0)) return list[0].price;
    const above = list.filter((x) => x.price > mark).map((x) => x.price);
    const below = list.filter((x) => x.price < mark).map((x) => x.price);
    if (kind === 'tp') {
      if (side === 'long') return above.length ? Math.min(...above) : nearest(list);
      return below.length ? Math.max(...below) : nearest(list);
    }
    if (side === 'long') return below.length ? Math.max(...below) : nearest(list);
    return above.length ? Math.min(...above) : nearest(list);
  };

  return {
    tpPrice: pickBySide(tps, 'tp'),
    stopPrice: pickBySide(sls, 'sl'),
    tpPrices: tps.map((x) => x.price).sort((a, b) => a - b),
    stopPrices: sls.map((x) => x.price).sort((a, b) => a - b),
    tpCount: tps.length,
    stopCount: sls.length,
    source: tps.length || sls.length ? 'order' : 'none',
    tpDetail: tps,
    stopDetail: sls,
  };
}

/**
 * 没有真实挂单时的估算止损价（仅作参考，前端会标注「估算」）。
 * 关键修正：止损必须落在「入场价」与「强平价」之间，
 * 上一版用 liq*1.15 当缓冲，当强平价离入场价很近时会算出
 * 跑到入场价另一侧的荒谬数字（多头止损 85.34 > 均价 77.88）。
 */
export function clampStopToLiq(side, byPct, refPrice, liq, gapFrac = 0.2) {
  const ref = Number(refPrice);
  const pct = Number(byPct);
  if (!(ref > 0) || !Number.isFinite(pct) || pct <= 0) return 0;
  const lq = Number(liq);
  if (!(lq > 0)) return pct;
  const gap = Math.min(Math.max(Number(gapFrac) || 0, 0), 0.9);
  if (side === 'short') {
    // 空头：入场价 < 止损 < 强平价
    const ceil = lq > ref ? lq - (lq - ref) * gap : ref * 1.01;
    return Math.max(Math.min(pct, ceil), ref * 1.0005);
  }
  // 多头：强平价 < 止损 < 入场价
  const floor = lq < ref ? lq + (ref - lq) * gap : ref * 0.99;
  return Math.min(Math.max(pct, floor), ref * 0.9995);
}
