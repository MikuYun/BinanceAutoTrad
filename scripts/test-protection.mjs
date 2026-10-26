/**
 * protection.js 的单元测试（node --test 可直接跑，也可 node 直接执行看打印）。
 *
 * 覆盖用户报的那个 bug：
 *   实盘持仓 均价 77.87836、数量 4.37、30x、权益约 16.18
 *   旧版算出止损 85.34（跑到了入场价另一侧，明显不可能）
 *   新版必须落在「强平价 74.99」与「入场价 77.88」之间
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { protectionFromOrders, clampStopToLiq } from '../src/binance/protection.js';
import { liqPrice, stopTargetFor, safeStop, tpTargetFor } from '../src/strategy/solver.js';
import { normalizeParams } from '../src/strategy/params.js';

const ORDERS = [
  {
    symbol: 'HYPEUSDT', side: 'SELL', positionSide: 'LONG',
    type: 'TAKE_PROFIT_MARKET', stopPrice: '80.50000', reduceOnly: true, closePosition: true,
  },
  {
    symbol: 'HYPEUSDT', side: 'SELL', positionSide: 'LONG',
    type: 'STOP_MARKET', stopPrice: '76.20000', reduceOnly: true, closePosition: true,
  },
  {
    symbol: 'HYPEUSDT', side: 'SELL', positionSide: 'LONG',
    type: 'LIMIT', price: '90', stopPrice: '0',
  },
  {
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
    type: 'TAKE_PROFIT_MARKET', stopPrice: '1', reduceOnly: true,
  },
];

test('从币安挂单里正确识别多仓的止盈/止损', () => {
  const r = protectionFromOrders(ORDERS, { symbol: 'HYPEUSDT', side: 'long', markPrice: 78.25785 });
  assert.equal(r.tpPrice, 80.5);
  assert.equal(r.stopPrice, 76.2);
  assert.equal(r.tpCount, 1);
  assert.equal(r.stopCount, 1);
  assert.equal(r.source, 'order');
});

test('空仓的挂单方向相反（BUY 平空）', () => {
  const orders = [
    { symbol: 'HYPEUSDT', side: 'BUY', positionSide: 'SHORT', type: 'TAKE_PROFIT_MARKET', stopPrice: '75', reduceOnly: true },
    { symbol: 'HYPEUSDT', side: 'BUY', positionSide: 'SHORT', type: 'STOP_MARKET', stopPrice: '82', reduceOnly: true },
  ];
  const r = protectionFromOrders(orders, { symbol: 'HYPEUSDT', side: 'short', markPrice: 78 });
  assert.equal(r.tpPrice, 75);
  assert.equal(r.stopPrice, 82);
});

test('没有挂单时返回 source=none（平台不应自己编价格）', () => {
  const r = protectionFromOrders(ORDERS, { symbol: 'ETHUSDT', side: 'long', markPrice: 2000 });
  assert.equal(r.source, 'none');
  assert.equal(r.tpPrice, 0);
  assert.equal(r.stopPrice, 0);
});

test('止损必须落在强平价与入场价之间（回归用户截图）', () => {
  const rp = normalizeParams({});
  const avg = 77.87836;
  const qty = 4.37;
  const equity = 16.18;
  const liq = liqPrice(qty, avg, equity, 'long');
  const raw = stopTargetFor('long', avg, qty, equity, rp);
  const safe = safeStop('long', raw, avg, liq);

  assert.ok(liq > 0, '强平价应为正');
  assert.ok(safe > liq, `止损 ${safe} 必须在强平 ${liq} 之上`);
  assert.ok(safe < avg, `止损 ${safe} 必须在入场价 ${avg} 之下`);

  const tp = tpTargetFor('long', avg, rp);
  assert.ok(tp > avg, '多头止盈应在入场价之上');
});

test('clampStopToLiq 把翻到错误一侧的止损拉回来', () => {
  // 多头：止损 85.34 比入场 77.88 还高（旧 bug）
  const fixed = clampStopToLiq('long', 85.34, 77.87836, 74.98681);
  assert.ok(fixed < 77.87836, '修复后止损必须低于入场价');
  assert.ok(fixed > 74.98681 * 0.99, '修复后止损不能低于强平价太多');
});

test('空头止损同样夹在入场价与强平价之间', () => {
  const rp = normalizeParams({});
  const avg = 100;
  const qty = 1;
  const equity = 20;
  const liq = liqPrice(qty, avg, equity, 'short');
  if (liq > 0) {
    const safe = safeStop('short', stopTargetFor('short', avg, qty, equity, rp), avg, liq);
    assert.ok(safe > avg, `空头止损 ${safe} 必须高于入场价 ${avg}`);
    assert.ok(safe < liq, `空头止损 ${safe} 必须低于强平价 ${liq}`);
  }
});
