/**
 * 实盘保护单（止盈 / 止损）管理。
 *
 * 背景（用户第二轮问题 #10）：
 *   机器人开的仓在币安上是**裸仓** —— 平台只在内存里算止盈止损价，从不真的挂单。
 *   结果账户页「止盈价 / 止损价」两列永远显示「—」，行情跳空时也没人替你止损。
 *
 * 本模块只做两件事：
 *   1. desiredCondOrders()  纯函数：根据机器人自己的账本（liveLegs）+ 参数，算出「应该挂哪些条件单」；
 *   2. diffCondOrders()     纯函数：和「已经挂着的」比对，得出「该撤哪些、该挂哪些」。
 * 真正的下单/撤单由 runner 调用 live.js 完成（本模块不碰网络，方便单测）。
 *
 * 三条红线：
 *   - 数量只填**机器人自己那一份**（ownQty），绝不 closePosition，否则会平掉用户手动仓；
 *   - clientOrderId 由「侧 + 类型 + 触发价 + 数量」派生 —— 同样的意图永远同一个 id，
 *     网络超时重发会被币安按重复 id 拒掉，不会变成两笔单；
 *   - 触发价/数量任何一个变了就换新 id，先撤旧单再挂新单，不会留下幽灵单。
 */

/** 触发价与数量都会影响 id：值变了就必须是新单 */
function condId(robotId, side, type, triggerPrice, qty) {
  const rb = String(robotId).replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'r';
  const sd = side === 'short' ? 's' : 'l';
  const t = type === 'tp' ? 'tp' : 'sl';
  const sig = `${side}|${t}|${Number(triggerPrice).toFixed(6)}|${Number(qty).toFixed(6)}`;
  let h = 2166136261;
  for (let i = 0; i < sig.length; i += 1) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hash = (h >>> 0).toString(36).padStart(6, '0').slice(-6);
  return `bt${rb}${sd}${t}${hash}`.slice(0, 36);
}

function r6(v) {
  return Number.isFinite(v) ? Number(v.toFixed(6)) : 0;
}

/**
 * 算出「应该存在的条件单」。
 *
 * 止盈：
 *   - avg 模式：整边挂一对，触发价 = 实际均价 ±tpPct，数量 = 该边合计；
 *   - layer 模式：每笔各挂一个 TAKE_PROFIT_MARKET，触发价 = 该笔入场价 ±tpPct，数量 = 该笔数量。
 * 止损：无论哪种止盈模式，止损都是「整边一个」，触发价由 stopTargetFor 夹在 entry 与 liq 之间。
 *
 * @param {object} p
 * @param {string} p.robotId
 * @param {{long:Array, short:Array}} p.legs   机器人自己的持仓账本
 * @param {object} p.params                    归一化后的参数
 * @param {number} p.price                     当前标记价（算强平价用）
 * @param {number} p.equity                    账户权益（算强平价用，不是 allocatedCapital）
 * @param {object} p.rules                     交易所规则（判最小名义）
 * @param {object} p.fns                       依赖注入：{tpTargetFor, stopTargetFor, liqPrice}
 * @returns {{orders:Array, skipped:Array}}
 */
export function desiredCondOrders(p) {
  const {
    robotId, legs, params, price, equity, rules = {}, fns,
  } = p || {};
  const orders = [];
  const skipped = [];
  if (!legs || !fns) return { orders, skipped };

  const minNotional = Number(rules.minNotional) > 0 ? Number(rules.minNotional) : 5;
  const tpMode = params && params.tpMode === 'layer' ? 'layer' : 'avg';

  for (const side of ['long', 'short']) {
    const arr = Array.isArray(legs[side]) ? legs[side].filter((x) => Number(x.qty) > 0) : [];
    if (!arr.length) continue;

    const qtySum = arr.reduce((s, x) => s + Number(x.qty), 0);
    const notionalSum = arr.reduce((s, x) => s + Number(x.qty) * Number(x.entryPrice), 0);
    const avgEntry = qtySum > 0 ? notionalSum / qtySum : 0;
    if (!(avgEntry > 0)) continue;

    /* ---------- 止盈 ---------- */
    if (tpMode === 'layer') {
      for (const leg of arr) {
        const qty = Number(leg.qty);
        const entry = Number(leg.entryPrice);
        if (!(qty > 0) || !(entry > 0)) continue;
        const trigger = fns.tpTargetFor(side, entry, params);
        if (!(trigger > 0)) continue;
        if (entry * qty < minNotional) {
          skipped.push({ side, type: 'tp', qty, reason: `这一笔名义 ${(entry * qty).toFixed(2)}U 低于 ${minNotional}U，币安不允许挂条件单` });
          continue;
        }
        orders.push({
          id: condId(robotId, side, 'tp', trigger, qty),
          side,
          type: 'tp',
          triggerPrice: r6(trigger),
          quantity: r6(qty),
          layer: Number(leg.layer) || 0,
        });
      }
    } else {
      const trigger = fns.tpTargetFor(side, avgEntry, params);
      if (trigger > 0) {
        if (avgEntry * qtySum < minNotional) {
          skipped.push({ side, type: 'tp', qty: qtySum, reason: `整边名义 ${(avgEntry * qtySum).toFixed(2)}U 低于 ${minNotional}U` });
        } else {
          orders.push({
            id: condId(robotId, side, 'tp', trigger, qtySum),
            side,
            type: 'tp',
            triggerPrice: r6(trigger),
            quantity: r6(qtySum),
            layer: 0,
          });
        }
      }
    }

    /* ---------- 止损（整边一个） ---------- */
    const liq = fns.liqPrice(qtySum, avgEntry, equity, side);
    const stop = fns.stopTargetFor(side, avgEntry, qtySum, equity, params);
    if (stop > 0) {
      if (avgEntry * qtySum < minNotional) {
        skipped.push({ side, type: 'sl', qty: qtySum, reason: `整边名义 ${(avgEntry * qtySum).toFixed(2)}U 低于 ${minNotional}U` });
      } else {
        orders.push({
          id: condId(robotId, side, 'sl', stop, qtySum),
          side,
          type: 'sl',
          triggerPrice: r6(stop),
          quantity: r6(qtySum),
          layer: 0,
          liqPrice: r6(liq),
        });
      }
    }
  }
  return { orders, skipped };
}

/**
 * 比对「已经挂着的」与「应该挂着的」。
 *
 * @param {Array} existing  state_json.condOrders（我们挂出去并且确认成功的）
 * @param {Array} desired   desiredCondOrders().orders
 * @param {Array} [openOrders] 交易所返回的挂单（用来剔除已经成交/被撤掉的幽灵记录）
 * @returns {{toCancel:Array, toPlace:Array, next:Array}}
 */
export function diffCondOrders(existing, desired, openOrders) {
  const ex = Array.isArray(existing) ? existing.filter((x) => x && x.id) : [];
  const want = Array.isArray(desired) ? desired.filter((x) => x && x.id) : [];

  // 交易所上还活着的 id 集合（拿不到就不做幽灵清理，宁可多留一条也不要误清）
  let alive = null;
  if (Array.isArray(openOrders)) {
    alive = new Set(
      openOrders
        .map((o) => String(o.clientOrderId || ''))
        .filter((s) => s.startsWith('bt')),
    );
  }

  const wantIds = new Set(want.map((x) => x.id));
  const heldIds = new Set(ex.map((x) => x.id));

  const toCancel = ex.filter((x) => {
    if (!wantIds.has(x.id)) return true; // 不再需要（仓位变了 / 触发价变了）
    if (alive && !alive.has(x.id)) return true; // 交易所上已经没了（成交或过期）
    return false;
  });

  const toPlace = want.filter((x) => !heldIds.has(x.id));

  // next = 想保留的 + 这次要新挂的（挂成功后再由 runner 决定是否真的写入）
  const canceled = new Set(toCancel.map((x) => x.id));
  const next = [
    ...ex.filter((x) => !canceled.has(x.id)),
    ...toPlace,
  ];
  return { toCancel, toPlace, next };
}

/**
 * 把 state_json.condOrders 从「按 side 分组」规整成扁平数组（兼容两种历史结构）。
 */
export function normalizeCondOrders(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((x) => x && x.id);
  const out = [];
  for (const side of ['long', 'short']) {
    const arr = raw[side];
    if (Array.isArray(arr)) for (const x of arr) if (x && x.id) out.push({ ...x, side: x.side || side });
  }
  return out;
}
