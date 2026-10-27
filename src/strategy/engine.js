/**
 * 策略引擎：单次决策（纯判断，不落库、不下单）。
 *
 * 这一版修正了三个关键错误：
 *  1. **止盈价必须用「当前实际持仓均价」现算**，绝不能用「加满后的预测均价」。
 *     （上一版用满仓均价，导致只开 1 层时止盈价落在现价错误一侧，开仓立刻平仓。）
 *  2. **止损价同样按实际均价现算**，并与强平价取更早触发的那个。
 *  3. **层数是上限**：第一笔只开 1 层，只有价格真的朝不利方向走过间距才加下一层。
 *
 * 状态机：
 *   IDLE ──(建首层)──▶ HOLDING ──(踩到间距)──▶ 加仓(层数+1) ──▶ … ──(到顶)──▶ FULL
 *     ▲                   │                                          │
 *     └───(止盈/止损全平)──┴──────────────────────────────────────────┘
 */
import { solvePlan, tpTargetFor, stopTargetFor, safeStop, liqPrice, minOrderNotional, canPlaceNotional } from './solver.js';
import { paperExchange } from '../binance/paper.js';

/** 读取某一方向当前的实际持仓摘要 */
export function sideState(book, side, markPrice) {
  if (!book) {
    return { qty: 0, avgEntry: 0, unrealizedPnl: 0, layers: 0, notional: 0, margin: 0, legs: [] };
  }
  const s = paperExchange.summarizeSide(book, side, markPrice);
  return {
    qty: s.qty,
    avgEntry: s.avgEntry,
    unrealizedPnl: s.unrealizedPnl,
    layers: s.legs,
    notional: s.notional,
    margin: s.margin,
    legs: (book.positions && book.positions[side]) || [],
  };
}

/**
 * 单次决策。
 *
 * @param {object} p
 * @param {object} p.params   已归一化参数
 * @param {object} p.book     模拟账本（实盘传 null）
 * @param {number} p.markPrice 当前标记价格
 * @param {number} p.equity   账户真实权益（只用于算强平价）
 * @param {object} [p.rules]  交易所规则
 * @param {object} [p.quote]  实盘持仓快照
 * @param {number} [p.atrPct] 兼容旧调用，仅展示
 * @param {number} [p.anchorPrice] 计划价格锚点（来自上次计划，缺省用当前价）
 * @param {number} [p.realizedPnl] 本机器人自己的累计已实现盈亏（并入资金基数）
 * @returns {{actions:Array, plan:object, halted:boolean, notes:string[]}}
 */
export function decide(p) {
  const {
    params, book, markPrice, equity, rules = {}, quote = null, anchorPrice: rawAnchor,
    realizedPnl: rawRealizedPnl,
  } = p || {};

  const actions = [];
  const notes = [];
  // 价格锚点：优先沿用上一次计划的基准价，让加仓线不随行情漂移
  const anchorPrice = Number(rawAnchor) > 0 ? Number(rawAnchor) : Number(markPrice);
  // 三种方向：双向 / 只做多 / 只做空
  const direction = ['long', 'short', 'dual'].includes(String(params.direction))
    ? String(params.direction)
    : 'dual';

  // 先把两边当前的实际持仓摸清楚，再让求解器知道「已经建到第几层」
  const sides = direction === 'dual'
    ? ['long', 'short']
    : [direction === 'short' ? 'short' : 'long'];
  const states = {};
  let maxLayers = 0;
  for (const side of sides) {
    const st = book
      ? sideState(book, side, markPrice)
      : (() => {
          const pos = ((quote && quote.positions) || []).find((x) => x.side === side);
          return pos
            ? {
                qty: pos.qty,
                avgEntry: pos.entryPrice,
                unrealizedPnl: pos.unrealizedPnl,
                layers: 1,
                notional: pos.qty * pos.entryPrice,
                margin: pos.margin,
                legs: [],
              }
            : { qty: 0, avgEntry: 0, unrealizedPnl: 0, layers: 0, notional: 0, margin: 0, legs: [] };
        })();
    states[side] = st;
    if (st.layers > maxLayers) maxLayers = st.layers;
  }

  const plan = solvePlan({
    equity,
    price: markPrice,
    params,
    rules,
    direction,
    currentLayers: maxLayers,
    anchorPrice,
    realizedPnl: rawRealizedPnl,
  });

  if (!plan.feasible) {
    for (const n of plan.notes || []) notes.push(n);
    notes.push('当前参数下计划不可行，本次不动作');
    return { actions, plan, halted: false, notes };
  }

  const tpMode = plan.tpMode;
  // 最小可下单名义：plan 已经按「rules 的 minNotional 与 minQty×stepSize 取大」算好了，直接用。
  // （以前只看 minNotional，像 SKHYNIXUSDT 这种 minQty=0.01 的标的会被高估可行性）
  const minNotional = Number(plan.minOrderNotional || plan.minNotional) > 0
    ? Number(plan.minOrderNotional || plan.minNotional)
    : minOrderNotional(markPrice, rules);

  // 这个机器人「分配给自己的资金」以及「已经占用的保证金」。
  // 用户问题 #3：多机器人共用一个账户，如果每个都按账户全额算，账户资金会被
  // 重复分配，多开一个机器人就多一份爆仓风险。所以每笔新开/加仓都要先确认
  // 「本机器人已占用 + 本笔 <= allocatedCapital」。
  const capitalBudget = Number(plan.capital) > 0 ? Number(plan.capital) : Number(equity) || 0;
  // 已占用保证金 = 各方向名义 / 杠杆。
  // 注意不能直接读 leg.margin：实盘账本的 leg 是 runner 用成交回执拼出来的，
  // 里面只有 qty/entryPrice，没有 margin 字段，读 margin 会恒为 0 → 预算闸永远不生效。
  const lev = Math.max(1, Number(plan.leverage) || 1);
  let ownUsedMargin = 0;
  for (const side of sides) ownUsedMargin += Math.max(0, Number(states[side].notional) || 0) / lev;

  for (const side of sides) {
    const st = states[side];
    const hasPosition = st.qty > 0;

    /* ---------- 无持仓：建首层（只开 1 层，不预填） ---------- */
    if (!hasPosition) {
      const notional = plan.firstLayerNotional;
      if (minNotional > 0 && !canPlaceNotional(notional, markPrice, { ...rules, minNotional })) {
        notes.push(`${side} 第一笔名义 ${notional.toFixed(2)}U 低于该标的的最小可下单金额 ${minNotional.toFixed(2)}U，跳过`);
        continue;
      }
      // 预算闸：本机器人已占用的保证金 + 这一笔不能超过分配资金
      const needFirst = notional / Math.max(1, plan.leverage);
      if (capitalBudget > 0 && ownUsedMargin + needFirst > capitalBudget + 1e-9) {
        notes.push(
          `${side} 第一笔要占用保证金 ${needFirst.toFixed(2)}U，`
            + `本机器人已占用 ${ownUsedMargin.toFixed(2)}U，超过分配资金 ${capitalBudget.toFixed(2)}U，跳过`,
        );
        continue;
      }
      actions.push({
        type: 'open',
        side,
        layer: 1,
        notional,
        price: markPrice,
        reason: '建第一笔',
      });
      continue;
    }

    /* ---------- 有持仓：1) 止损（永远按实际均价现算） ---------- */
    // 止损必须夹在「入场价」与「强平价」之间（强平很近时不能翻到另一侧）
    const stopRaw = stopTargetFor(side, st.avgEntry, st.qty, equity, params);
    const stopPrice = safeStop(
      side,
      stopRaw,
      st.avgEntry,
      liqPrice(st.qty, st.avgEntry, equity, side),
    );
    const hitStop = side === 'long' ? markPrice <= stopPrice : markPrice >= stopPrice;
    if (hitStop) {
      actions.push({
        type: 'close',
        side,
        price: markPrice,
        reason: `止损（均价 ${st.avgEntry.toFixed(4)} 的 ${params.stopPct}% → ${stopPrice.toFixed(4)}）`,
      });
      continue;
    }

    /* ---------- 2) 止盈（永远按实际均价现算，这是核心修复） ---------- */
    if (tpMode === 'avg') {
      // 整体止盈：整边一起走，触发价 = 实际均价 ± tpPct
      const tpPrice = tpTargetFor(side, st.avgEntry, params);
      const hitTp = side === 'long' ? markPrice >= tpPrice : markPrice <= tpPrice;
      if (hitTp) {
        actions.push({
          type: 'close',
          side,
          price: markPrice,
          reason: `整体止盈（实际均价 ${st.avgEntry.toFixed(4)} + ${params.tpPct}% → ${tpPrice.toFixed(4)}）`,
        });
        continue;
      }
    } else {
      // 逐笔止盈：只平掉已经到价的那几笔，剩下的继续扛
      const g = Number(params.tpPct || 0) / 100;
      const hitLegIds = st.legs
        .filter((leg) => {
          const target = side === 'long'
            ? Number(leg.entryPrice) * (1 + g)
            : Number(leg.entryPrice) * (1 - g);
          return side === 'long' ? markPrice >= target : markPrice <= target;
        })
        .map((leg) => leg.id);
      if (hitLegIds.length) {
        actions.push({
          type: 'close',
          side,
          price: markPrice,
          legIds: hitLegIds,
          reason: `逐笔止盈（${hitLegIds.length} 笔到价）`,
        });
        continue;
      }
    }

    /* ---------- 3) 加仓：价格相对实际均价走过一层间距 ---------- */
    const nextLayer = st.layers + 1;
    if (nextLayer > plan.layers) {
      notes.push(`${side} 已加到计划上限 ${plan.layers} 层，只等止盈或止损`);
      continue;
    }

    const spacing = plan.spacingPct / 100;
    const triggerPrice = side === 'long'
      ? st.avgEntry * (1 - spacing)
      : st.avgEntry * (1 + spacing);
    const shouldAdd = side === 'long' ? markPrice <= triggerPrice : markPrice >= triggerPrice;
    if (!shouldAdd) continue;

    const layerNotional = plan.firstLayerNotional * Math.pow(plan.growRatio, st.layers);
    if (minNotional > 0 && !canPlaceNotional(layerNotional, markPrice, { ...rules, minNotional })) {
      notes.push(`${side} 第 ${nextLayer} 笔名义 ${layerNotional.toFixed(2)}U 低于该标的的最小可下单金额 ${minNotional.toFixed(2)}U，加仓停止`);
      continue;
    }
    const newMargin = layerNotional / Math.max(1, plan.leverage);
    // 加仓上限按「分配给这个机器人的资金」累计算，不是整个账户权益、也不是单笔对比
    const capitalLimit = capitalBudget > 0 ? capitalBudget : equity;
    if (ownUsedMargin + newMargin > capitalLimit + 1e-9) {
      notes.push(
        `${side} 第 ${nextLayer} 笔保证金 ${newMargin.toFixed(2)}U 加上已占用 `
          + `${ownUsedMargin.toFixed(2)}U 超过分配资金 ${capitalLimit.toFixed(2)}U，加仓停止`,
      );
      continue;
    }

    actions.push({
      type: 'open',
      side,
      layer: nextLayer,
      notional: Number(layerNotional.toFixed(6)),
      price: markPrice,
      reason: `价格触到加仓线 ${triggerPrice.toFixed(4)}（实际均价 ${st.avgEntry.toFixed(4)} 的 ${plan.spacingPct}%）`,
    });
  }

  return { actions, plan, halted: false, notes };
}

export { solvePlan };
