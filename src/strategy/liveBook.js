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
 * 「保留手动仓」的基准快照。
 *
 * 用户创建实盘机器人时，如果该币已经有持仓，可以选择「保留」：
 * 这些持仓被登记为**手动仓基准**，之后每 tick 对账时先从交易所总量里减掉基准，
 * 剩下的差额才算「机器人自己的 + 后来手动加减的」，避免机器人把用户原本的仓
 * 当成自己加出来的仓去算层数、算均价、去平仓。
 *
 * @param {Array} positions fetchAccount().positions（已按 symbol 过滤）
 * @returns {{long:number, short:number, at:number}}
 */
export function snapshotBaseline(positions) {
  const list = Array.isArray(positions) ? positions : [];
  return {
    long: num((list.find((p) => p && p.side === 'long') || {}).qty),
    short: num((list.find((p) => p && p.side === 'short') || {}).qty),
    at: Date.now(),
  };
}

/** 从 state_json 里读出基准（容错） */
export function parseBaseline(state) {
  const b = (state && state.manualBaseline) || {};
  return { long: num(b.long), short: num(b.short), at: num(b.at) };
}

/** 基准是否非空（有任何一个方向 > 0） */
export function hasBaseline(baseline) {
  if (!baseline) return false;
  return num(baseline.long) > 1e-12 || num(baseline.short) > 1e-12;
}

/**
 * 与交易所实际持仓对账。
 *
 * @param {object} legs 账本（机器人自己的持仓）
 * @param {Array} positions quote.positions（{side,qty,entryPrice,...}）
 * @param {object} [baseline] 手动仓基准（snapshotBaseline 的产物，可为空）
 * @returns {{legs:object, own:object, manual:object, clamped:object, missing:object}}
 *   missing[side] = true 表示「账本里还有机器人的仓，但交易所上这个方向已经空了」
 *   —— 只可能是用户手动把（含机器人的）仓全平了，必须显式告诉用户，不能静默清账本。
 */
export function reconcile(legs, positions, baseline) {
  const list = Array.isArray(positions) ? positions : [];
  const base = baseline || { long: 0, short: 0 };
  const own = {};
  const manual = {};
  const clamped = {};
  const missing = {};
  for (const side of SIDES) {
    const rawQty = num((list.find((p) => p && p.side === side) || {}).qty);
    const myQty = ownQty(legs, side);
    // 手动仓基准的「剩余量」：用户减仓时优先认为他减的是自己的仓，而不是机器人的。
    // 例：用户原有 10 张，机器人开了 1 张（共 11），用户把自己的 10 张全平 → 交易所剩 1 张，
    //     这时基准应该剩 0、而不是 10，否则机器人会误以为「自己的仓被平光了」然后重新建仓——
    //     这就是之前那个「手动平仓后机器人重建大仓」的 bug。
    const baseLeft = Math.max(0, Math.min(num(base[side]), Math.max(0, rawQty - myQty)));
    // 扣掉用户手动仓（基准剩余）之后，才是机器人可认领的量
    const exQty = Math.max(0, rawQty - baseLeft);
    if (myQty > exQty + 1e-12) {
      // 交易所实际比账本少：用户手动平掉了一部分（甚至含机器人的），账本按实际数量缩减
      const cut = myQty - exQty;
      if (exQty <= 1e-12) {
        legs[side] = [];
        missing[side] = true;
      } else {
        drainQty(legs, side, cut);
      }
      clamped[side] = cut;
    }
    own[side] = { qty: Math.min(ownQty(legs, side), exQty), avgEntry: ownAvgEntry(legs, side) };
    manual[side] = Math.max(0, rawQty - baseLeft - ownQty(legs, side));
  }
  return { legs, own, manual, clamped, missing };
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
