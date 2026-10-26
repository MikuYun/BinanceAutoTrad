import test from 'node:test';
import assert from 'node:assert/strict';

import { desiredCondOrders, diffCondOrders, normalizeCondOrders } from '../src/strategy/protect.js';
import { tpTargetFor, stopTargetFor, liqPrice } from '../src/strategy/solver.js';

const fns = { tpTargetFor, stopTargetFor, liqPrice };
const RULES = { minNotional: 5 };

function leg(qty, entryPrice, layer = 1) {
  return { id: 'l' + layer, qty, entryPrice, layer };
}

test('avg 模式：多单整边挂一个止盈 + 一个止损', () => {
  const legs = { long: [leg(0.1, 100)], short: [] };
  const { orders, skipped } = desiredCondOrders({
    robotId: 'r1', legs, params: { tpMode: 'avg', tpPct: 1, stopPct: 5 },
    price: 100, equity: 1000, rules: RULES, fns,
  });
  assert.equal(skipped.length, 0);
  assert.equal(orders.length, 2);
  const tp = orders.find((o) => o.type === 'tp');
  const sl = orders.find((o) => o.type === 'sl');
  assert.ok(tp && sl);
  assert.equal(tp.side, 'long');
  assert.equal(tp.triggerPrice, 101);
  assert.equal(tp.quantity, 0.1);
  assert.ok(sl.triggerPrice < 100, '止损必须在入场价下方');
  assert.ok(sl.triggerPrice < tp.triggerPrice);
  assert.ok(tp.id && sl.id, '每张条件单都要有确定性 id');
});

test('空单方向相反：止盈低于入场、止损高于入场', () => {
  const legs = { long: [], short: [leg(0.2, 100)] };
  const { orders } = desiredCondOrders({
    robotId: 'r2', legs, params: { tpMode: 'avg', tpPct: 1, stopPct: 5 },
    price: 100, equity: 1000, rules: RULES, fns,
  });
  const tp = orders.find((o) => o.type === 'tp');
  const sl = orders.find((o) => o.type === 'sl');
  assert.ok(tp.triggerPrice < 100, '空单止盈在入场价下方');
  assert.ok(sl.triggerPrice > 100, '空单止损在入场价上方');
  assert.equal(tp.side, 'short');
});

test('止损夹在入场价与强平价之间（回归：85.34 高于入场 77.88 的 bug）', () => {
  const legs = { long: [leg(4.37, 77.87836)], short: [] };
  const { orders } = desiredCondOrders({
    robotId: 'r3', legs, params: { tpMode: 'avg', tpPct: 0.5, stopPct: 5 },
    price: 78.25, equity: 16.18, rules: RULES, fns,
  });
  const sl = orders.find((o) => o.type === 'sl');
  const liq = liqPrice(4.37, 77.87836, 16.18, 'long');
  assert.ok(sl.triggerPrice < 77.87836, '止损不能高于入场价');
  assert.ok(sl.triggerPrice > liq, '止损必须在强平价之上');
});

test('layer 模式：每笔各挂一个止盈，止损只有一个', () => {
  const legs = { long: [leg(0.1, 100, 1), leg(0.15, 99, 2)], short: [] };
  const { orders } = desiredCondOrders({
    robotId: 'r4', legs, params: { tpMode: 'layer', tpPct: 1, stopPct: 5 },
    price: 99.5, equity: 1000, rules: RULES, fns,
  });
  const tps = orders.filter((o) => o.type === 'tp');
  const sls = orders.filter((o) => o.type === 'sl');
  assert.equal(tps.length, 2);
  assert.equal(sls.length, 1);
  // 第一笔入场 100 → 止盈 101；第二笔入场 99 → 止盈 99.99
  assert.deepEqual(tps.map((o) => o.triggerPrice).sort((a, b) => a - b), [99.99, 101]);
  assert.equal(new Set(tps.map((o) => o.id)).size, 2, '两笔的 id 必须不同');
});

test('名义不足 5U 进 skipped 而不是下单', () => {
  const legs = { long: [leg(0.001, 100)], short: [] };
  const { orders, skipped } = desiredCondOrders({
    robotId: 'r5', legs, params: { tpMode: 'avg', tpPct: 1, stopPct: 5 },
    price: 100, equity: 1000, rules: RULES, fns,
  });
  assert.equal(orders.length, 0);
  assert.ok(skipped.length >= 1);
  assert.match(skipped[0].reason, /名义/);
});

test('没有持仓时不产生任何条件单', () => {
  const { orders, skipped } = desiredCondOrders({
    robotId: 'r6', legs: { long: [], short: [] }, params: { tpMode: 'avg' },
    price: 100, equity: 1000, rules: RULES, fns,
  });
  assert.equal(orders.length, 0);
  assert.equal(skipped.length, 0);
});

test('diffCondOrders：已有的同 id 挂单不重复下单', () => {
  const desired = [
    { id: 'btr1ltpabc001', type: 'tp', side: 'long', triggerPrice: 101, quantity: 0.1 },
    { id: 'btr1lslabc002', type: 'sl', side: 'long', triggerPrice: 95, quantity: 0.1 },
  ];
  const existing = [...desired];
  const open = [
    { type: 'TAKE_PROFIT_MARKET', positionSide: 'LONG', stopPrice: '101', origQty: '0.1', clientOrderId: 'btr1ltpabc001' },
    { type: 'STOP_MARKET', positionSide: 'LONG', stopPrice: '95', origQty: '0.1', clientOrderId: 'btr1lslabc002' },
  ];
  const r = diffCondOrders(existing, desired, open);
  assert.equal(r.toPlace.length, 0);
  assert.equal(r.toCancel.length, 0);
  assert.equal(r.next.length, 2);
});

test('diffCondOrders：触发价变了要撤旧挂新', () => {
  const desired = [{ id: 'btr1ltpnew002', type: 'tp', side: 'long', triggerPrice: 102, quantity: 0.1 }];
  const existing = [{ id: 'btr1ltpold001', type: 'tp', side: 'long', triggerPrice: 101, quantity: 0.1 }];
  const open = [{ type: 'TAKE_PROFIT_MARKET', positionSide: 'LONG', stopPrice: '101', origQty: '0.1', clientOrderId: 'btr1ltpold001' }];
  const r = diffCondOrders(existing, desired, open);
  assert.equal(r.toPlace.length, 1);
  assert.equal(r.toPlace[0].id, 'btr1ltpnew002');
  assert.equal(r.toCancel.length, 1);
  assert.equal(r.toCancel[0].id, 'btr1ltpold001');
  assert.deepEqual(r.next.map((x) => x.id), ['btr1ltpnew002']);
});

test('diffCondOrders：交易所上已经成交/消失的挂单要清理', () => {
  const desired = [{ id: 'btr2ltpabc001', type: 'tp', side: 'long', triggerPrice: 101, quantity: 0.1 }];
  const existing = [{ id: 'btr2ltpabc001', type: 'tp', side: 'long', triggerPrice: 101, quantity: 0.1 }];
  const open = []; // 交易所没这张单了
  const r = diffCondOrders(existing, desired, open);
  assert.equal(r.toCancel.length, 1, '交易所上没了的单要撤掉记录');
  assert.equal(r.toPlace.length, 0, '仍然需要的单不算新挂');
});

test('normalizeCondOrders：兼容扁平数组与按 side 分组两种历史结构', () => {
  assert.deepEqual(normalizeCondOrders(null), []);
  assert.deepEqual(normalizeCondOrders('x'), []);
  const flat = normalizeCondOrders([{ id: 'x1', type: 'tp', side: 'long' }, { noid: 1 }]);
  assert.equal(flat.length, 1);
  const grouped = normalizeCondOrders({
    long: [{ id: 'x2', type: 'tp' }],
    short: [{ id: 'x3', type: 'sl' }],
  });
  assert.equal(grouped.length, 2);
  assert.equal(grouped.find((x) => x.id === 'x2').side, 'long');
  assert.equal(grouped.find((x) => x.id === 'x3').side, 'short');
});
