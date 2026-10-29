/**
 * 接管模式（用户 m06852）单元测试。
 *
 * 用户要求：
 *   1. 机器人启动后必须接管该交易对**全部**仓位（不管谁开的）；
 *   2. 已有仓位时不再加仓，等「按交易所真实均价算出的实际止盈价」到了一次性全平；
 *   3. 全平之后才重新建第一层。
 *
 * 这里保护的就是这三条，尤其是第 2 条里的「整边全平」——
 * 即使 tpMode 是逐笔（layer），接管期间也必须整边全平，不能只平一部分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decide } from '../src/strategy/engine.js';
import { normalizeParams } from '../src/strategy/params.js';
import {
  emptyLiveLegs,
  addLeg,
  bookOf,
  parseTakeover,
  emptyTakeover,
  takeoverSides,
  reconcile,
} from '../src/strategy/liveBook.js';

const RULES = { minNotional: 5, stepSize: 0.001, tickSize: 0.0001, minQty: 0.001 };

function p(over = {}) {
  return normalizeParams({
    direction: 'long',
    allocatedCapital: 100,
    firstPct: 1,
    leverage: 20,
    growRatio: 1.5,
    spacingPct: 1,
    maxLayers: 6,
    totalPct: 3,
    maxLossPct: 35,
    tpMode: 'avg',
    tpPct: 0.5,
    stopPct: 5,
    interval: '5m',
    ...over,
  });
}

/** 模拟一笔「从交易所接管来的」仓位。 */
function takeoverBook(qty, entryPrice) {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', {
    qty,
    entryPrice,
    leverage: 20,
    layer: 1,
    source: 'takeover',
    reason: '接管交易所已有仓位',
  });
  return { legs, book: bookOf(legs) };
}

test('接管状态判空：emptyTakeover / parseTakeover / takeoverSides', () => {
  const empty = emptyTakeover();
  assert.equal(takeoverSides(empty).long, false);
  assert.equal(takeoverSides(empty).short, false);

  const parsed = parseTakeover({ takeover: { long: { qty: 2, entryPrice: 100 } } });
  assert.equal(takeoverSides(parsed).long, true);
  assert.equal(takeoverSides(parsed).short, false);

  // 脏数据不能当真
  assert.equal(takeoverSides(parseTakeover(null)).long, false);
  assert.equal(takeoverSides(parseTakeover({ takeover: { long: { qty: 'x' } } })).long, false);
});

test('接管期间不加仓（价格往反方向走也不加）', () => {
  const params = p();
  const { book } = takeoverBook(5, 100);
  const takeover = { long: { qty: 5, entryPrice: 100, at: Date.now() }, short: null };

  // 价格跌到 97（比均价低 3%，远超 1% 的加仓间距）→ 正常情况下应该加仓
  const withTakeover = decide({
    params,
    book,
    markPrice: 97,
    equity: 1000,
    rules: RULES,
    takeover,
  });
  const openActions = withTakeover.actions.filter((a) => a.type === 'open');
  assert.equal(openActions.length, 0, '接管期间绝不能开新仓/加仓');
  assert.ok(
    withTakeover.notes.some((n) => n.includes('接管')),
    '必须留下「正在接管」的说明',
  );

  // 对照：没有接管状态时，同样价格会加仓 —— 证明上面那条确实是接管闸门挡住的
  const noTakeover = decide({ params, book, markPrice: 97, equity: 1000, rules: RULES });
  assert.ok(
    noTakeover.actions.some((a) => a.type === 'open'),
    '没有接管状态时跌 3% 应该触发加仓',
  );
});

test('接管期间止盈：tpMode=layer 也必须整边全平（关键用户要求）', () => {
  const params = p({ tpMode: 'layer', tpPct: 0.5 });
  const { book } = takeoverBook(5, 100);
  const takeover = { long: { qty: 5, entryPrice: 100, at: Date.now() }, short: null };

  // 实际均价 100，止盈价 100.5；涨到 100.6 → 必须触发「整边」平仓
  const r = decide({ params, book, markPrice: 100.6, equity: 1000, rules: RULES, takeover });
  const close = r.actions.find((a) => a.type === 'close');
  assert.ok(close, '到止盈价必须平仓');
  assert.equal(close.legIds, undefined, '接管止盈必须是整边全平，不能只传部分 legIds');
  assert.ok(close.reason.includes('接管止盈'), `原因应标明接管止盈，实际：${close.reason}`);
  assert.ok(close.reason.includes('整边全平'));
});

test('接管止盈价按交易所真实均价算，不按机器人预测价', () => {
  const params = p({ tpPct: 0.5 });
  // 交易所真实均价 95（用户手动开的仓摊低了成本），涨到 95.5 就该全平
  const { book } = takeoverBook(8, 95);
  const takeover = { long: { qty: 8, entryPrice: 95, at: Date.now() }, short: null };

  const below = decide({ params, book, markPrice: 95.4, equity: 1000, rules: RULES, takeover });
  assert.equal(below.actions.filter((a) => a.type === 'close').length, 0, '95.4 未到 95.5，不该平');

  const above = decide({ params, book, markPrice: 95.6, equity: 1000, rules: RULES, takeover });
  assert.equal(above.actions.filter((a) => a.type === 'close').length, 1, '95.6 已过 95.5，必须全平');
});

test('接管仓位同样受硬止损保护（不能只等止盈）', () => {
  const params = p({ stopPct: 5 });
  const { book } = takeoverBook(5, 100);
  const takeover = { long: { qty: 5, entryPrice: 100, at: Date.now() }, short: null };
  const r = decide({ params, book, markPrice: 90, equity: 1000, rules: RULES, takeover });
  const close = r.actions.find((a) => a.type === 'close');
  assert.ok(close, '跌破止损必须平仓');
  assert.ok(close.reason.includes('止损'), `实际：${close.reason}`);
});

test('全部平掉后接管状态消失，可以重新建第一层', () => {
  // 账本里原来有 5 张（接管来的），交易所已经归零 → 账本清空 + 标 missing + 接管状态消失
  const { legs } = takeoverBook(5, 100);
  const rec = reconcile(legs, [], { long: { qty: 5, entryPrice: 100, at: Date.now() }, short: null });
  assert.equal(takeoverSides(rec.takeover).long, false, '交易所归零后接管状态必须清空');
  assert.equal(rec.missing.long, true, '要标记「账本被清空」这个事实');

  // 空账本 + 无接管 → 应该建第一层
  const params = p();
  const r = decide({
    params,
    book: bookOf(emptyLiveLegs()),
    markPrice: 100,
    equity: 1000,
    rules: RULES,
    takeover: rec.takeover,
  });
  const open = r.actions.find((a) => a.type === 'open');
  assert.ok(open, '平掉之后应该重新建第一笔');
  assert.equal(open.layer, 1);
});

test('对账：交易所有仓、账本为空 → 全部接管且均价等于交易所真实均价', () => {
  const legs = emptyLiveLegs();
  const rec = reconcile(legs, [{ side: 'long', qty: 3, entryPrice: 92.5 }], emptyTakeover());
  assert.equal(rec.adopted.long, 3);
  assert.equal(rec.own.long.qty, 3);
  assert.ok(Math.abs(rec.own.long.avgEntry - 92.5) < 1e-9, '接管后均价必须等于交易所真实均价');
  assert.equal(takeoverSides(rec.takeover).long, true);
});

test('对账：账本已有机器人自己开的仓 + 交易所多出来的 → 增量接管后均价仍等于交易所均价', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 1, entryPrice: 100, leverage: 20, layer: 1 });
  // 交易所：2 张，均价 97 → 总名义 194；账本已有 100 → 增量名义 94 / 增量 1 张 = 94
  const rec = reconcile(legs, [{ side: 'long', qty: 2, entryPrice: 97 }], emptyTakeover());
  assert.equal(rec.adopted.long, 1);
  assert.ok(Math.abs(rec.own.long.avgEntry - 97) < 1e-9, '接管后整边均价必须等于交易所真实均价');
  assert.equal(rec.own.long.qty, 2);
});

test('对账容差按 stepSize 算，半个步长内的精度误差不算手动减仓（P1-2）', () => {
  const legs = emptyLiveLegs();
  addLeg(legs, 'long', { qty: 2, entryPrice: 100, leverage: 20, layer: 1 });
  // stepSize=0.01 → 容差 0.005。交易所报 1.997 与账本 2 差 0.003，在容差内
  const rec = reconcile(legs, [{ side: 'long', qty: 1.997, entryPrice: 100 }], emptyTakeover(), {
    stepSize: 0.01,
  });
  assert.equal(rec.drained.long, undefined, '容差内不该触发「手动减仓」');
  assert.equal(rec.adopted.long, undefined, '容差内也不该触发「接管」');
  assert.equal(rec.eps, 0.005);

  // 差 0.02（超过容差）→ 确实算手动减仓
  const rec2 = reconcile(legs, [{ side: 'long', qty: 1.98, entryPrice: 100 }], emptyTakeover(), {
    stepSize: 0.01,
  });
  assert.ok(rec2.drained.long > 0, '超出容差要按实际缩减');
});
