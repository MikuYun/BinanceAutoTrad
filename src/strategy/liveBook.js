/**
 * 实盘「机器人自己的持仓」账本。
 *
 * 为什么需要它：
 *   币安 U 本位在「双向持仓」模式下，同一个 symbol 的多头是**账户级聚合**的。
 *   positionRisk 只告诉你「HYPEUSDT 多单 4.37 张」，没法区分其中多少是机器人开的、
 *   多少是用户手动开的。如果机器人直接把这段持仓当成自己的，就会去平掉用户手动开的仓
 *   —— 这是真金白银的事故。
 *
 * 做法：
 *   机器人每次开仓成功后，把「这一笔」记进 state_json.liveLegs；
 *   每次平仓按数量从账本里扣掉。每 tick 再与交易所实际持仓对账：
 *     · 交易所数量 > 账本数量  → 超出部分视为「手动仓」，机器人不碰；
 *     · 交易所数量 < 账本数量  → 用户手动平掉了一部分，账本按比例缩减。
 *
 * 账本只用于「算仓位、算层数、算均价、限制平仓数量」，权益永远取交易所真实值。
 */

const SIDES = ['long', 'short'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 空账本 */
export function emptyLiveLegs() {
  return { long: [], short: [] };
}

/** 从 state_json 里读出账本（容错：老数据 / 脏数据都当空） */
export function parseLiveLegs(state) {
  const src = (state && state.liveLegs) || {};
  const out = emptyLiveLegs();
  for (const side of SIDES) {
    const arr = Array.isArray(src[side]) ? src[side] : [];
    out[side] = arr
      .map((l) => ({
        id: l && l.id ? String(l.id) : `${side}_${Math.random().toString(36).slice(2, 10)}`,
        qty: num(l && l.qty),
        entryPrice: num(l && l.entryPrice),
        notional: num(l && l.notional),
        margin: num(l && l.margin),
        leverage: num(l && l.leverage) || 1,
        layer: Math.max(1, Math.floor(num(l && l.layer) || 1)),
        openedAt: num(l && l.openedAt) || Date.now(),
        clientId: l && l.clientId ? String(l.clientId) : '',
        reason: l && l.reason ? String(l.reason) : '',
        source: l && l.source ? String(l.source) : '',
      }))
      .filter((l) => l.qty > 0 && l.entryPrice > 0);
  }
  return out;
}

/** 某方向账本合计数量 */
export function ownQty(legs, side) {
  return (legs[side] || []).reduce((s, l) => s + num(l.qty), 0);
}

/** 某方向账本加权均价 */
export function ownAvgEntry(legs, side) {
  const arr = legs[side] || [];
  const q = ownQty(legs, side);
  if (!(q > 0)) return 0;
  return arr.reduce((s, l) => s + num(l.qty) * num(l.entryPrice), 0) / q;
}

/** 记一笔新开仓 */
export function addLeg(legs, side, leg) {
  const arr = legs[side] || (legs[side] = []);
  const qty = num(leg.qty);
  const entryPrice = num(leg.entryPrice);
  if (!(qty > 0) || !(entryPrice > 0)) return legs;
  arr.push({
    id: leg.id || `${side}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    qty,
    entryPrice,
    notional: num(leg.notional) || qty * entryPrice,
    margin: num(leg.margin) || (qty * entryPrice) / (num(leg.leverage) || 1),
    leverage: num(leg.leverage) || 1,
    // 'takeover' = 从交易所已有持仓接管进来的那一笔（不加仓，只等止盈全平）
    source: leg.source ? String(leg.source) : '',
    layer: Math.max(1, Math.floor(num(leg.layer) || arr.length + 1)),
    openedAt: num(leg.openedAt) || Date.now(),
    clientId: leg.clientId ? String(leg.clientId) : '',
    reason: leg.reason ? String(leg.reason) : '',
  });
  return legs;
}

/**
 * 按数量从账本里扣掉（平仓时用）。按比例缩减每一笔，保留均价不变。
 * @returns {{legs:object, closedQty:number, avgEntry:number}}
 */
export function drainQty(legs, side, qty) {
  const arr = legs[side] || [];
  const total = ownQty(legs, side);
  const want = num(qty);
  if (!(want > 0) || !(total > 0)) return { legs, closedQty: 0, avgEntry: 0 };
  const take = Math.min(want, total);
  const avgEntry = ownAvgEntry(legs, side);
  const keepRatio = (total - take) / total;
  const next = [];
  for (const l of arr) {
    const q = num(l.qty) * keepRatio;
    if (q > 1e-12) next.push({ ...l, qty: q, notional: q * num(l.entryPrice) });
  }
  legs[side] = next;
  return { legs, closedQty: take, avgEntry };
}

/** 只扣掉指定几笔（逐笔止盈模式用） */
export function drainLegs(legs, side, legIds) {
  const ids = new Set(Array.isArray(legIds) ? legIds : [legIds]);
  const arr = legs[side] || [];
  let closedQty = 0;
  let sum = 0;
  const keep = [];
  for (const l of arr) {
    if (ids.has(l.id)) {
      closedQty += num(l.qty);
      sum += num(l.qty) * num(l.entryPrice);
      continue;
    }
    keep.push(l);
  }
  legs[side] = keep;
  return { legs, closedQty, avgEntry: closedQty > 0 ? sum / closedQty : 0 };
}

/**
 * 接管来的仓位块（side → {qty, entryPrice, at} 或 null）。
 *
 * 为什么要单独记：
 *   用户在启动机器人时该币可能已经有仓（自己手动开的，或者上一版机器人没记进账本留下的）。
 *   用户要求「机器人接管这个币的所有仓位」——接管过来的这部分**不加仓**，只按交易所真实均价
 *   算出的止盈价，到价后一次性全部平掉，然后再从第一层重新开始。
 */
export function emptyTakeover() {
  return { long: null, short: null };
}

/** 从 state_json 里读出接管块（容错） */
export function parseTakeover(state) {
  const src = (state && state.takeover) || {};
  const out = emptyTakeover();
  for (const side of SIDES) {
    const b = src[side];
    if (b && num(b.qty) > 0 && num(b.entryPrice) > 0) {
      out[side] = { qty: num(b.qty), entryPrice: num(b.entryPrice), at: num(b.at) || Date.now() };
    }
  }
  return out;
}

/** 某方向是否是「接管仓」（只等止盈、不加仓） */
export function takeoverSides(takeover) {
  const out = { long: false, short: false };
  for (const side of SIDES) {
    out[side] = Boolean(takeover && takeover[side] && num(takeover[side].qty) > 0);
  }
  return out;
}

/**
 * 与交易所实际持仓对账（接管模式）。
 *
 * 和上一版的区别：上一版会把手动仓当成「永远不碰的基准」隔离掉，结果就是用户报的那个事故——
 * 机器人下的单没被记进账本时，它以为那是手动仓，于是只按自己账本里那点数量做交易。
 * 现在改成「交易所是唯一真相源」：
 *   · 交易所数量 < 账本数量 → 有人（用户）平掉了一部分，账本按实际数量缩减；
 *   · 交易所数量 > 账本数量 → 多出来的部分**接管**进账本（按增量反解出入场价，
 *     保证账本加权均价 == 交易所均价），之后会和机器人自己的仓一起被止盈平掉；
 *   · 交易所已经归零但账本里还有 → 记 missing，显式提醒用户，不能静默清账本。
 *
 * @param {object} legs     机器人账本
 * @param {Array}  positions quote.positions（已按 symbol 过滤，{side,qty,entryPrice,...}）
 * @param {object} [takeover] 上一轮的接管块（parseTakeover 的产物）
 * @param {object} [rules]    交易所规则（用 stepSize 算对账容差）
 * @returns {{legs:object, takeover:object, own:object, adopted:object, drained:object, missing:object, eps:number}}
 */
export function reconcile(legs, positions, takeover, rules) {
  const list = Array.isArray(positions) ? positions : [];
  const prev = takeover || emptyTakeover();
  const own = {};
  const adopted = {};
  const drained = {};
  const missing = {};
  const next = emptyTakeover();

  // 对账容差（用户文档 P1-2）：交易所的数量是按 stepSize 四舍五入报的，
  // 拿 1e-12 当容差会把「精度误差」误判成「有人手动减仓」，每轮报一次假警告。
  // 用 stepSize/2 作为容差：差在半个步长之内都当成同一个数。
  const step = num(rules && rules.stepSize);
  const eps = Math.max(1e-8, step > 0 ? step / 2 : 0);

  for (const side of SIDES) {
    const pos = list.find((p) => p && p.side === side);
    const exQty = pos ? num(pos.qty) : 0;
    const exAvg = pos ? num(pos.entryPrice) : 0;
    const myQty = ownQty(legs, side);

    if (!(exQty > 0)) {
      // 交易所这个方向已经空了（容差内的小尾巴不算「还有仓」）
      if (myQty > eps) {
        legs[side] = [];
        missing[side] = true;
      } else if (myQty > 0) {
        // 只是精度尾巴，直接对齐到 0，不报「账本被清空」这种惊人警告
        legs[side] = [];
      }
      own[side] = { qty: ownQty(legs, side), avgEntry: ownAvgEntry(legs, side) };
      continue;
    }

    if (myQty > exQty + eps) {
      // 交易所比账本少：有人手动平掉了一部分（可能含机器人那份），账本按实际缩减
      const cut = myQty - exQty;
      drainQty(legs, side, cut);
      drained[side] = cut;
    } else if (myQty < exQty - eps) {
      // 交易所比账本多：多出来的接管进账本。
      // 入场价用「增量反解」：总名义(交易所) − 账本已有名义 = 这一笔的名义，
      // 这样账本的加权均价恰好等于交易所的真实均价，止盈价才是用户要的「实际止盈价」。
      const addQty = exQty - myQty;
      const totalNotional = exQty * exAvg;
      const mineNotional = (legs[side] || []).reduce((s, l) => s + num(l.qty) * num(l.entryPrice), 0);
      let addEntry = addQty > 0 ? (totalNotional - mineNotional) / addQty : 0;
      if (!(addEntry > 0)) addEntry = exAvg; // 脏数据兜底，绝不让均价跑飞
      addLeg(legs, side, {
        qty: addQty,
        entryPrice: addEntry,
        layer: 1,
        source: 'takeover',
        reason: '接管交易所已有仓位',
      });
      adopted[side] = addQty;
    }

    // 该方向只要「本轮接管过」或者「上一轮还在接管中」，就持续保持接管模式，
    // 直到这个方向的仓完全空了（下一轮 exQty<=0 会让 next[side] 回到 null）。
    // 用户 m06852 的要求就是：一旦有这个方向的仓（不管是机器人还是手动建的），
    // 就等按真实均价算出的止盈价一次性全平，中途不加仓；平完再重建第一层。
    const wasTakeover = Boolean(prev[side] && num(prev[side].qty) > 0);
    const arr = legs[side] || [];
    const allTakeover = arr.length > 0 && arr.every((l) => l.source === 'takeover');
    if (adopted[side] || wasTakeover || allTakeover) {
      next[side] = {
        qty: ownQty(legs, side),
        entryPrice: ownAvgEntry(legs, side),
        at: (prev[side] && prev[side].at) || Date.now(),
      };
    }

    own[side] = { qty: ownQty(legs, side), avgEntry: ownAvgEntry(legs, side) };
  }

  return { legs, takeover: next, own, adopted, drained, missing, eps };
}

/** 把账本转成 engine 能吃的 book（复用 paper 的 summarizeSide 路径） */
export function bookOf(legs) {
  return { positions: { long: legs.long || [], short: legs.short || [] } };
}

/**
 * 只保留指定交易对的持仓。
 *
 * 为什么必须有这一步：币安 `GET /fapi/v2/positionRisk` 不带 symbol 时返回的是
 * **整个账户所有交易对**的持仓。不过滤的话会出两个事故：
 *   1. 页面「已建仓笔数」把别的币的仓位也算进来 —— 刚启动就显示层数已满；
 *   2. 对账时可能拿 HYPEUSDT 的仓当成 BNBUSDT 的仓，平错数量。
 */
export function filterBySymbol(positions, symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return [];
  return (Array.isArray(positions) ? positions : [])
    .filter((p) => p && String(p.symbol || '').toUpperCase() === sym);
}
