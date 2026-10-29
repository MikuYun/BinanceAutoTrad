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
  parseTakeover,
  emptyTakeover,
  takeoverSides,
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

test('对账：交易所比账本多 → 多出来的部分全部接管进账本', () => {
  const book = emptyLiveLegs();
  addLeg(book, 'long', { qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  // 机器人账本 1 张 @100，交易所 4 张 @99.5（其中 3 张是用户手动开的/上一版漏记的）
  const rec = reconcile(book, [{ side: 'long', qty: 4, entryPrice: 99.5 }]);
  assert.equal(rec.adopted.long, 3);
  assert.equal(rec.drained.long, undefined);
  assert.equal(rec.missing.long, undefined);
  // 接管后账本数量必须等于交易所数量
  assert.equal(ownQty(book, 'long'), 4);
  // 关键：账本加权均价必须等于交易所真实均价，否则止盈价不是「实际止盈价」
  assert.ok(Math.abs(ownAvgEntry(book, 'long') - 99.5) < 1e-9);
  // 全部都是接管来的 → 进入接管模式
  assert.ok(rec.takeover.long);
  assert.equal(rec.takeover.long.qty, 4);
  // 另一个方向没有仓 → 不是接管模式
  assert.equal(rec.takeover.short, null);
});

test('对账：账本为空但交易所有仓 → 全部接管（事故修复的核心）', () => {
  // 事故现场：机器人重复下单把交易所加到 0.7 张，账本是 0 张。
  const legs = emptyLiveLegs();
  const rec = reconcile(legs, [{ side: 'long', qty: 0.7, entryPrice: 976.11 }]);
  assert.ok(Math.abs(rec.adopted.long - 0.7) < 1e-9);
  assert.ok(Math.abs(ownQty(legs, 'long') - 0.7) < 1e-9);
  assert.ok(Math.abs(ownAvgEntry(legs, 'long') - 976.11) < 1e-9);
  assert.equal(rec.takeover.long.qty, 0.7);
});

test('对账：部分接管时账本里机器人自己的笔不受影响，但整边进入接管模式', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { id: 'mine', qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  const rec = reconcile(legs, [{ side: 'long', qty: 2, entryPrice: 99 }]);
  const mine = legs.long.find((l) => l.id === 'mine');
  assert.ok(mine);
  assert.equal(mine.qty, 1);
  assert.equal(mine.entryPrice, 100);
  // 用户 m06852：「机器人接管这一个币的所有仓位」——只要监控到有非机器人仓，
  // 整个方向就进入接管模式：等实际止盈价一次性全平，中途不加仓。
  assert.ok(rec.takeover.long);
  assert.ok(Math.abs(rec.takeover.long.qty - 2) < 1e-9);
  assert.ok(Math.abs(ownAvgEntry(legs, 'long') - 99) < 1e-9);
});

test('对账：有人手动减仓 → 账本按比例缩减，均价不变', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  addLeg(legs, 'long', { qty: 1.5, entryPrice: 99, leverage: 20, layer: 2 });
  const avgBefore = ownAvgEntry(legs, 'long');
  const rec = reconcile(legs, [{ side: 'long', qty: 2, entryPrice: avgBefore }]);
  assert.ok(rec.drained.long > 0);
  assert.ok(Math.abs(ownQty(legs, 'long') - 2) < 1e-9);
  assert.ok(Math.abs(ownAvgEntry(legs, 'long') - avgBefore) < 1e-9);
});

test('对账：交易所归零但账本里还有 → 清账本并标 missing', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  const rec = reconcile(legs, [{ side: 'long', qty: 0 }]);
  assert.equal(ownQty(legs, 'long'), 0);
  assert.equal(rec.own.long.qty, 0);
  assert.equal(rec.missing.long, true);
  assert.equal(rec.takeover.long, null);
});

test('接管块：解析容错 + 判定', () => {
  assert.deepEqual(parseTakeover(null), { long: null, short: null });
  const t = parseTakeover({
    takeover: {
      long: { qty: 3, entryPrice: 100, at: 123 },
      short: { qty: 0, entryPrice: 0 },
    },
  });
  assert.equal(t.long.qty, 3);
  assert.equal(t.long.entryPrice, 100);
  assert.equal(t.short, null);
  // 脏数据
  const dirty = parseTakeover({ takeover: { long: { qty: 'x', entryPrice: 'y' } } });
  assert.equal(dirty.long, null);
  assert.deepEqual(takeoverSides(null), { long: false, short: false });
  assert.deepEqual(takeoverSides(t), { long: true, short: false });
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
