/**
 * 求解器：把「人话参数 + 当前价格」算成一张看得懂的加仓计划表。
 *
 * 重要设计（针对上一版的两个错误）：
 *  1. **不预先把止盈价钉死**。计划表里的「加满后均价 / 加满后止盈」只是预测，
 *     真正下单时止盈价必须用「当前实际持仓均价」现算（见 tpTargetFor / stopTargetFor）。
 *  2. **层数是上限，不是现实**。第一笔只开 1 层；只有价格真的朝不利方向走过
 *     spacingPct 才加一层。layerList 里每一行都是「如果价格走到这里会怎样」。
 *
 * 资金基数（2026-10 第三轮修正，用户问题 #3）：
 *  - 仓位尺寸全部按 **allocatedCapital（分配给这个机器人的钱）** 算，不再按账户权益。
 *    这样同一个机器人在大账户、小账户里开的仓位一致，也不会越权动用账户其余资金。
 *  - 唯一的例外是 **强平价 liqPrice**：全仓强平价取决于整个账户的权益与全部持仓，
 *    必须继续传账户真实权益 equity，否则算出来的强平位是假的。
 *
 * 价格锚点（用户问题 #7）：
 *  - 阶梯触发价以 anchorPrice 为基准（第一次计划生成时的价格），
 *    这样计划表不会随行情整体漂移；只有「当前该盯的止盈/止损」跟实际均价走。
 *
 * 流程：
 *   1. 名义 = 分配资金 × firstPct% × 杠杆；之后每次加仓金额 = 上次 × growRatio
 *   2. 间距 spacingPct（直接就是百分比，不乘 ATR）
 *   3. 层数从 maxLayers 往下试，直到同时满足三条硬约束
 *   4. 算出每层累积均价、加满后的止盈价 / 止损价 / 强平价
 */

const MMR = 0.005; // 维持保证金率近似（U 本位小仓位档）
const LIQ_BUFFER = 0.2; // 止损价与强平价之间的安全间距（占 entry↔liq 区间的比例）

/** 交易所最小名义兜底（U 本位永续 5U）。live.js 会从 exchangeInfo 取真实值。 */
export const DEFAULT_MIN_NOTIONAL = 5;

/**
 * 全仓强平价（近似）。
 *
 * 这里的 equity 必须是**账户真实权益**（不是 allocatedCapital）：
 * 全仓模式下强平由整个账户的保证金率决定，与「分给这个机器人的钱」无关。
 */
export function liqPrice(qty, avgEntry, equity, side = 'long') {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (side === 'short') return (qty * avgEntry + equity) / (qty * (1 + MMR));
  return (qty * avgEntry - equity) / (qty * (1 - MMR));
}

function round6(v) {
  if (!Number.isFinite(v)) return 0;
  return Number((v > 0 ? v : 0).toFixed(6));
}
function round2(v) {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : 0;
}

/**
 * 当前持仓的止盈价（永远按「实际均价」算，这是修掉开仓即平的关键）。
 * @param {'long'|'short'} side
 * @param {number} avgEntry 当前实际持仓均价
 * @param {object} params 已归一化参数
 */
export function tpTargetFor(side, avgEntry, params) {
  if (!(avgEntry > 0)) return 0;
  const g = (Number(params.tpPct) > 0 ? Number(params.tpPct) : 0.5) / 100;
  return side === 'long' ? avgEntry * (1 + g) : avgEntry * (1 - g);
}

/**
 * 当前持仓的止损价：取「按幅度算的止损」与「强平价留缓冲」两者中更早触发的那个。
 * 这样既尊重用户设的 stopPct，也保证不会被强平。
 * @param {'long'|'short'} side
 * @param {number} avgEntry
 * @param {number} qty
 * @param {number} equity
 * @param {object} params
 */
export function stopTargetFor(side, avgEntry, qty, equity, params) {
  if (!(avgEntry > 0)) return 0;
  const s = (Number(params.stopPct) > 0 ? Number(params.stopPct) : 5) / 100;
  const liq = liqPrice(qty, avgEntry, equity, side);
  const byPct = side === 'long' ? avgEntry * (1 - s) : avgEntry * (1 + s);
  return safeStop(side, byPct, avgEntry, liq, LIQ_BUFFER);
}

/**
 * 把「按幅度算的止损」夹到「入场价」与「强平价」之间。
 *
 * 上一版的错误：多头止损写成 liq*1.15。当强平价离入场价很近时
 * （30x 全仓、只有 16U 权益顶着 340U 名义），liq*1.15 会直接冲到入场价上方
 * （实测：均价 77.88、强平 74.99 → 算出 85.34 这种根本不存在的止损价）。
 * 正确做法是让止损落在 liq 与 entry 之间，且至少离开强平价一部分距离。
 *
 * @param {'long'|'short'} side
 * @param {number} byPct  按幅度算出来的止损价
 * @param {number} ref    入场均价
 * @param {number} liq    强平价
 * @param {number} [gapFrac] 距强平价的最小安全距离（占 entry↔liq 区间的比例）
 */
export function safeStop(side, byPct, ref, liq, gapFrac = 0.2) {
  const pct = Number(byPct);
  const r = Number(ref);
  if (!(r > 0)) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  const lq = Number(liq);
  if (!(lq > 0)) return pct;
  if (side === 'short') {
    // 空头：入场价 < 止损 < 强平价
    const ceil = lq > r ? lq - (lq - r) * gapFrac : r * 1.01;
    const v = Math.min(pct, ceil);
    return Math.max(v, r * 1.0005);
  }
  // 多头：强平价 < 止损 < 入场价
  const floor = lq < r ? lq + (r - lq) * gapFrac : r * 0.99;
  const v = Math.max(pct, floor);
  return Math.min(v, r * 0.9995);
}

/**
 * 第 n 层加满后的累积均价与总数（等比金额 + 等比价格位置）。
 * 触发价以 anchor（价格锚点）为基准，不用当前价 —— 这样计划表不随行情漂移。
 */
function buildLadder(n, c) {
  const { anchor, gap, firstNotional, growRatio } = c;
  let sumQ = 0;
  let sumN = 0;
  let sumQS = 0;
  let sumNS = 0;
  const legs = [];
  for (let i = 0; i < n; i += 1) {
    const notional = firstNotional * Math.pow(growRatio, i);
    const pLong = anchor * Math.pow(1 - gap, i);
    const pShort = anchor * Math.pow(1 + gap, i);
    const qLong = notional / pLong;
    const qShort = notional / pShort;
    sumQ += qLong;
    sumN += notional;
    sumQS += qShort;
    sumNS += notional;
    legs.push({
      layer: i + 1,
      notional,
      margin: notional / Math.max(1, c.leverage),
      triggerLong: pLong, // 做多这边的触发价（价格跌到这里才加）
      triggerShort: pShort, // 做空这边的触发价（价格涨到这里才加）
      qtyLong: qLong,
      qtyShort: qShort,
      cumSumQ: sumQ,
      cumSumN: sumN,
      cumSumQS: sumQS,
      cumSumNS: sumNS,
    });
  }
  return legs;
}

/**
 * 主求解入口。
 *
 * @param {object} input
 * @param {number} input.equity      账户真实权益（USDT）——只用于算强平价
 * @param {number} input.price       当前标记价格
 * @param {object} input.params      已归一化参数（见 params.js）
 * @param {object} [input.rules]     交易所规则（minNotional 等）
 * @param {string} [input.direction] 'dual' | 'long' | 'short'
 * @param {number} [input.currentLayers] 当前实际已建层数（用于挑出「现在该看哪一行」）
 * @param {number} [input.atrPct]    兼容旧调用，仅用于展示，不参与计算
 * @param {number} [input.anchorPrice] 价格锚点（缺省用当前价）。传机器人的计划基准价，
 *                                    这样计划表不会随行情整体漂移。
 */
export function solvePlan(input) {
  const {
    equity: rawEquity,
    price: rawPrice,
    params = {},
    rules = {},
    direction = params.direction || 'dual',
    currentLayers = 0,
    anchorPrice: rawAnchor,
  } = input || {};

  // 账户权益：只用来算强平价（全仓强平取决于整个账户）
  const equity = Number(rawEquity) > 0 ? Number(rawEquity) : 100;
  const price = Number(rawPrice) > 0 ? Number(rawPrice) : 0;
  // 三种方向：双向 / 只做多 / 只做空
  const dir = ['long', 'short', 'dual'].includes(String(direction)) ? String(direction) : 'dual';
  const hasLong = dir === 'long' || dir === 'dual';
  const hasShort = dir === 'short' || dir === 'dual';
  const dual = hasLong && hasShort;
  const leverage = Math.max(1, Number(params.leverage) || 20);
  const firstPct = Number(params.firstPct) > 0 ? Number(params.firstPct) : 1;
  const gapPct = Number(params.spacingPct) > 0 ? Number(params.spacingPct) : 1;
  const growRatio = Math.max(1, Number(params.growRatio) || 1.5);
  const maxLayers = Math.max(1, Math.round(Number(params.maxLayers) || 6));
  const totalPct = Number(params.totalPct) > 0 ? Number(params.totalPct) : 3;
  const maxLossPct = Number(params.maxLossPct) > 0 ? Number(params.maxLossPct) : 35;
  const tpPct = Number(params.tpPct) > 0 ? Number(params.tpPct) : 0.5;
  const stopPct = Number(params.stopPct) > 0 ? Number(params.stopPct) : 5;
  const tpMode = params.tpMode === 'layer' ? 'layer' : 'avg';
  const minNotional = Number(rules.minNotional) > 0
    ? Number(rules.minNotional)
    : DEFAULT_MIN_NOTIONAL;

  // 资金基数：机器人只被授权动用「分配给自己的资金」。
  // 只有未配置（<=0 或缺失）时才回退到账户权益，保证老机器人还能跑。
  const allocated = Number(params.allocatedCapital);
  const capital = allocated > 0 ? allocated : equity;
  // 价格锚点：计划里的阶梯触发价都以它为基准
  const anchor = Number(rawAnchor) > 0 ? Number(rawAnchor) : price;

  const notes = [];
  const gap = gapPct / 100;
  const firstMargin = (firstPct / 100) * capital;
  const firstNotional = firstMargin * leverage;
  const capTotal = totalPct * capital; // 单方向名义上限
  const lossBudget = (maxLossPct / 100) * capital;

  const base = {
    feasible: false,
    direction: dir,
    hasLong,
    hasShort,
    leverage,
    price,
    equity,
    capital,
    anchorPrice: anchor,
    spacingPct: gapPct,
    growRatio,
    tpMode,
    tpPct,
    stopPct,
    maxLayers,
    totalPct,
    maxLossPct,
    firstLayerMargin: round6(firstMargin),
    firstMarginUsd: round6(firstMargin),
    firstLayerNotional: round6(firstNotional),
    minNotional,
    currentLayers: Math.max(0, Math.round(Number(currentLayers) || 0)),
    notes,
    layerList: [],
  };

  if (!(price > 0)) {
    notes.push('当前价格缺失，无法计算计划');
    return base;
  }
  if (firstNotional < minNotional) {
    notes.push(
      `第一笔金额太小：名义 ${firstNotional.toFixed(2)}U，低于交易所最小下单额 ${minNotional}U。`
        + '请把「分配给这个机器人的资金」或「第一笔保证金占比」调大。',
    );
    return base;
  }

  const ctx = { anchor, gap, firstNotional, growRatio, leverage };

  // 从 maxLayers 往下试，取第一个三条约束都过的层数
  let best = null;
  for (let n = maxLayers; n >= 1; n -= 1) {
    const legs = buildLadder(n, ctx);
    const last = legs[n - 1];

    const avgLong = last.cumSumN / last.cumSumQ;
    const avgShort = last.cumSumNS / last.cumSumQS;
    const qtyLong = last.cumSumQ;
    const qtyShort = last.cumSumQS;

    const liqLong = liqPrice(qtyLong, avgLong, equity, 'long');
    const liqShort = liqPrice(qtyShort, avgShort, equity, 'short');

    // 止损价：幅度止损 与 强平价缓冲 取更早触发的
    const stopLong = safeStop('long', avgLong * (1 - stopPct / 100), avgLong, liqLong);
    const stopShort = safeStop('short', avgShort * (1 + stopPct / 100), avgShort, liqShort);

    // 约束 1：单方向名义不超过上限
    const okNotional = last.cumSumN <= capTotal * 1.0001;
    // 约束 2：跌到止损位时的总亏损不超过预算（多空取较差的一边）
    const lossLong = qtyLong * Math.max(0, avgLong - stopLong);
    const lossShort = qtyShort * Math.max(0, stopShort - avgShort);
    // 只取真正会持仓的那一边来算最坏亏损
    const worstLoss = dual
      ? Math.max(lossLong, lossShort)
      : (hasShort ? lossShort : lossLong);
    const okLoss = worstLoss <= lossBudget * 1.0001;
    // 约束 3：止损必须真的在强平之前触发
    const okStop = (!hasLong || stopLong > liqLong * 1.0001)
      && (!hasShort || stopShort < liqShort / 1.0001);

    const cand = {
      layers: n,
      legs,
      avgLong,
      avgShort,
      qtyLong,
      qtyShort,
      liqLong,
      liqShort,
      stopLong,
      stopShort,
      worstLoss,
      okNotional,
      okLoss,
      okStop,
    };

    if (!best) best = cand; // 记下最接近的，用于报错
    if (okNotional && okLoss && okStop) {
      best = cand;
      if (n < maxLayers) {
        notes.push(
          `层数从 ${maxLayers} 自动降到 ${n}：再多加就突破风险上限了（总仓位或最大亏损）。`,
        );
      }
      break;
    }
  }

  if (!best) {
    notes.push('无法生成任何加仓计划');
    return base;
  }

  const n = best.layers;
  const legs = best.legs;

  // 每层：加完这一层之后的累积均价 / 止盈价 / 止损价
  const layerList = legs.map((lg) => {
    const avgL = lg.cumSumN / lg.cumSumQ;
    const avgS = lg.cumSumNS / lg.cumSumQS;
    const liqL = liqPrice(lg.cumSumQ, avgL, equity, 'long');
    const liqS = liqPrice(lg.cumSumQS, avgS, equity, 'short');
    const stopL = safeStop('long', avgL * (1 - stopPct / 100), avgL, liqL);
    const stopS = safeStop('short', avgS * (1 + stopPct / 100), avgS, liqS);
    const tpL = tpMode === 'avg' ? avgL * (1 + tpPct / 100) : lg.triggerLong * (1 + tpPct / 100);
    const tpS = tpMode === 'avg' ? avgS * (1 - tpPct / 100) : lg.triggerShort * (1 - tpPct / 100);
    return {
      layer: lg.layer,
      index: lg.layer,
      // 触发价：价格走到这里才会加这一层
      longTriggerPrice: round6(lg.triggerLong),
      shortTriggerPrice: round6(lg.triggerShort),
      // 兼容旧前端字段名
      entryPrice: round6(lg.triggerLong),
      shortEntryPrice: round6(lg.triggerShort),
      notional: round6(lg.notional),
      margin: round6(lg.margin),
      qty: round6(lg.qtyLong),
      shortQty: round6(lg.qtyShort),
      // 加完这一层之后的累积状态
      avgEntry: round6(avgL),
      avgEntryShort: round6(avgS),
      liqPrice: round6(liqL),
      liqPriceShort: round6(liqS),
      stopPrice: round6(stopL),
      stopPriceShort: round6(stopS),
      tpPrice: round6(tpL),
      tpPriceShort: round6(tpS),
      shortTpPrice: round6(tpS),
      belowMinNotional: lg.notional < minNotional,
    };
  });

  const feasible = best.okNotional && best.okLoss && best.okStop;
  if (!feasible) {
    if (!best.okNotional) {
      notes.push(
        `即使只开 1 层也超过单方向投入上限（${totalPct} 倍分配资金 = ${round2(capTotal)}U），`
          + '请调大「单方向最多投入多少钱」或调小第一笔比例。',
      );
    }
    if (!best.okLoss) {
      notes.push(
        `即使只开 1 层，走到止损位也会亏 ${round2(best.worstLoss)}U，超过设定的最大亏损 `
          + `${round2(lossBudget)}U。请调大最大亏损比例或调小第一笔。`,
      );
    }
    if (!best.okStop) {
      notes.push('止损价与强平价重叠：这个杠杆下仓位太危险，请降低杠杆或调大止损幅度。');
    }
  }

  const first = layerList[0];
  const last = layerList[n - 1];

  Object.assign(base, {
    feasible,
    layers: n,
    ratio: growRatio,
    gap: gapPct,
    notionalTotal: round6(legs[n - 1].cumSumN), // 单方向名义合计
    layerNotionalTotal: round6(legs[n - 1].cumSumN),
    marginTotal: round6(legs[n - 1].cumSumN / leverage),
    avgEntry: last.avgEntry,
    avgEntryShort: last.avgEntryShort,
    lastEntry: last.entryPrice,
    lastEntryShort: last.shortEntryPrice,
    liqPrice: last.liqPrice,
    liqPriceShort: last.liqPriceShort,
    tpPrice: last.tpPrice,
    tpPriceShort: last.tpPriceShort,
    stopPrice: last.stopPrice,
    stopPriceShort: last.stopPriceShort,
    // 第一层（也就是「现在」）的止盈价：这是用户当前该盯的数
    currentTpPrice: hasLong ? first.tpPrice : 0,
    currentTpPriceShort: hasShort ? first.tpPriceShort : 0,
    maxLoss: round2(best.worstLoss),
    // 最坏亏损相对「分配给这个机器人的资金」的占比（不是相对账户权益）
    maxLossPct: round2((best.worstLoss / capital) * 100),
    // 强平距离按锚点/现价算都行，这里用当前价（用户看向屏幕上现在的价格）
    liqDistancePct: round2(((price - last.liqPrice) / price) * 100),
    liqDistancePctShort: round2(((last.liqPriceShort - price) / price) * 100),
    layerList,
  });

  notes.push(
    `计划最多 ${n} 层：第一笔 ${round2(firstNotional)}U 名义（保证金 ${round2(firstMargin)}U），`
      + `之后每次是上一次的 ${growRatio} 倍，价格每走 ${gapPct}% 加一次。`,
  );
  if (n < maxLayers) {
    notes.push(`层数上限设的是 ${maxLayers}，但受风险约束只能加到 ${n} 层。`);
  }
  if (tpMode === 'avg') {
    notes.push(
      '整体止盈：实际止盈价 = 「当前实际持仓均价」+'
        + ` ${tpPct}%，不是表格里加满后的那个数。表格各行的止盈价只是「加到那一层之后会变成多少」。`,
    );
  } else {
    notes.push('逐笔止盈：每一笔各自到自己的入场价上方才平，前面几笔会先落袋。');
  }

  return base;
}

/** 兼容旧接口：前端层位表直接吃 layerList */
export function solveLayers(plan) {
  return (plan && plan.layerList) || [];
}
