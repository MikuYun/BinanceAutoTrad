/**
 * 实盘持仓账本（liveBook）单元测试。
 * 核心要保护的一条：机器人绝不能去平用户手动开的仓。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyLiveLegs,
  parseLiveLegs,
  addLeg,
  drainQty,
  drainLegs,
  reconcile,
  ownQty,
  ownAvgEntry,
  bookOf,
  filterBySymbol,
} from '../src/strategy/liveBook.js';

test('账本累加与加权均价', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  addLeg(legs, 'long', { qty: 1.5, entryPrice: 99, leverage: 20, layer: 2 });
  assert.equal(ownQty(legs, 'long'), 2.5);
  assert.ok(Math.abs(ownAvgEntry(legs, 'long') - (1 * 100 + 1.5 * 99) / 2.5) < 1e-9);
  assert.equal(legs.long.length, 2);
});

test('非法数据不进入账本', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 0, entryPrice: 100 });
  addLeg(legs, 'long', { qty: 1, entryPrice: 0 });
  assert.equal(legs.long.length, 0);
});

test('对账：交易所数量 > 账本数量时，多出来的是手动仓', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  const rec = reconcile(legs, [{ side: 'long', qty: 4, entryPrice: 99.5 }]);
  assert.equal(rec.own.long.qty, 1);
  assert.equal(rec.manual.long, 3);
  assert.equal(rec.clamped.long, undefined);
});

test('对账：用户手动平掉一部分，账本按比例缩减而不是消失', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  addLeg(legs, 'long', { qty: 1.5, entryPrice: 99, leverage: 20, layer: 2 });
  const avgBefore = ownAvgEntry(legs, 'long');
  const rec = reconcile(legs, [{ side: 'long', qty: 2 }]);
  assert.ok(rec.clamped.long > 0);
  assert.ok(Math.abs(ownQty(legs, 'long') - 2) < 1e-9);
  // 缩减不能改变均价
  assert.ok(Math.abs(ownAvgEntry(legs, 'long') - avgBefore) < 1e-9);
});

test('对账：用户把仓位全平了，账本清零，机器人不会去平不存在的仓', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  const rec = reconcile(legs, [{ side: 'long', qty: 0 }]);
  assert.equal(ownQty(legs, 'long'), 0);
  assert.equal(rec.own.long.qty, 0);
  assert.ok(rec.clamped.long > 0);
});

test('平仓按数量扣减，均价不变，数量扣不完就扣到 0', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 2, entryPrice: 100, leverage: 20, layer: 1 });
  const d1 = drainQty(legs, 'long', 0.5);
  assert.equal(d1.closedQty, 0.5);
  assert.ok(Math.abs(d1.avgEntry - 100) < 1e-9);
  assert.ok(Math.abs(ownQty(legs, 'long') - 1.5) < 1e-9);
  const d2 = drainQty(legs, 'long', 99);
  assert.equal(d2.closedQty, 1.5);
  assert.equal(ownQty(legs, 'long'), 0);
});

test('逐笔平仓只扣指定那几笔', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { id: 'a', qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  addLeg(legs, 'long', { id: 'b', qty: 2, entryPrice: 95, leverage: 20, layer: 2 });
  const d = drainLegs(legs, 'long', ['a']);
  assert.equal(d.closedQty, 1);
  assert.ok(Math.abs(d.avgEntry - 100) < 1e-9);
  assert.equal(legs.long.length, 1);
  assert.equal(legs.long[0].id, 'b');
});

test('bookOf 输出 engine 需要的结构', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'short', { qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  const b = bookOf(legs);
  assert.equal(b.positions.short.length, 1);
  assert.deepEqual(b.positions.long, []);
});

test('parseLiveLegs 容错脏数据', () => {
  assert.deepEqual(parseLiveLegs(null), { long: [], short: [] });
  assert.deepEqual(parseLiveLegs({ liveLegs: 'oops' }), { long: [], short: [] });
  const legs = parseLiveLegs({
    liveLegs: {
      long: [{ qty: '2', entryPrice: '100', layer: '3' }, { qty: -1, entryPrice: 100 }],
    },
  });
  assert.equal(legs.long.length, 1);
  assert.equal(legs.long[0].qty, 2);
  assert.equal(legs.long[0].layer, 3);
});

test('只保留本机器人交易对的持仓（回归：实盘刚启动就显示层数已满）', () => {
  const all = [
    { symbol: 'BNBUSDT', side: 'long', qty: 0.05 },
    { symbol: 'HYPEUSDT', side: 'long', qty: 3.7 },
    { symbol: 'HYPEUSDT', side: 'short', qty: 0.19 },
    { symbol: 'SPCXUSDT', side: 'long', qty: 0.26 },
    { symbol: 'SPCXUSDT', side: 'short', qty: 0.06 },
  ];
  const mine = filterBySymbol(all, 'BNBUSDT');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].symbol, 'BNBUSDT');
  // 大小写不敏感
  assert.equal(filterBySymbol(all, 'bnbusdt').length, 1);
  // 没有该交易对的持仓时返回空数组，而不是把别人的仓位当自己的
  assert.deepEqual(filterBySymbol(all, 'DOGEUSDT'), []);
  assert.deepEqual(filterBySymbol(null, 'BNBUSDT'), []);
  assert.deepEqual(filterBySymbol(all, ''), []);
});
