/**
 * 最小可下单量的回归测试。
 *
 * 背景（用户 m05357 报的问题）：
 *   机器人跑 SKHYNIXUSDT，minNotional 只有 5U，但 minQty = 0.01、stepSize = 0.01。
 *   价格 975 时，「0.01 个」这一最小单位就值 9.75U，所以低于 9.75U 的单根本下不出去。
 *   旧逻辑只看 minNotional，把「第一笔 6U」判成可行，实际下单时数量归整成 0 被拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  solvePlan,
  minOrderNotional,
  canPlaceNotional,
  qtyUnitsOf,
  requiredQtyUnits,
  DEFAULT_MIN_NOTIONAL,
} from '../src/strategy/solver.js';
import { decide } from '../src/strategy/engine.js';
import { normalizeParams } from '../src/strategy/params.js';

/** SKHYNIXUSDT 的「粗步长」规则：1 个单位 0.01，价格 975 → 每单位 9.75U */
const SKHYNIX = { symbol: 'SKHYNIXUSDT', minNotional: 5, minQty: 0.01, stepSize: 0.01, tickSize: 0.01 };
/** 常见 USDT 永续：0.001 步长 */
const HYPE = { symbol: 'HYPEUSDT', minNotional: 5, minQty: 0.001, stepSize: 0.001, tickSize: 0.001 };
/** BTCUSDT：名义门槛高（50U），步长细 */
const BTC = { symbol: 'BTCUSDT', minNotional: 50, minQty: 0.001, stepSize: 0.001, tickSize: 0.1 };

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

test('requiredQtyUnits 按 minQty/stepSize 算最小台阶数', () => {
  assert.equal(requiredQtyUnits(SKHYNIX), 1, 'minQty 0.01 / step 0.01 → 1 个单位');
  assert.equal(requiredQtyUnits(HYPE), 1);
  assert.equal(requiredQtyUnits(BTC), 1);
  assert.equal(requiredQtyUnits({ minQty: 0.05, stepSize: 0.01 }), 5, 'minQty 是 step 的 5 倍 → 5 个单位');
  assert.equal(requiredQtyUnits({}), 0, '没有规则时返回 0（不做额外约束）');
});

test('qtyUnitsOf 与下单时的向下取整一致', () => {
  // 6U / 975 = 0.006154 → 按 step 0.01 只能落到 0 个单位
  assert.equal(qtyUnitsOf(6, 975, SKHYNIX), 0);
  // 9.75U / 975 = 0.01 → 正好 1 个单位
  assert.equal(qtyUnitsOf(9.75, 975, SKHYNIX), 1);
  // 15U / 975 = 0.01538 → 仍然是 1 个单位（不能有半个）
  assert.equal(qtyUnitsOf(15, 975, SKHYNIX), 1);
  // 20U / 100 = 0.2 → step 0.001 → 200 个单位
  assert.equal(qtyUnitsOf(20, 100, HYPE), 200);
});

test('minOrderNotional：取 minNotional 与 最小数量×价格 的较大值', () => {
  // SKHYNIX 价格 975：max(5, 0.01 × 975 = 9.75) = 9.75
  const n = minOrderNotional(975, SKHYNIX);
  assert.ok(Math.abs(n - 9.75) < 1e-6, `SKHYNIX 最小可下单名义应为 9.75U，实际 ${n}`);
  // 同一个标的，价格涨到 2000 → 最小名义变 20U
  const n2 = minOrderNotional(2000, SKHYNIX);
  assert.ok(Math.abs(n2 - 20) < 1e-6, `价格 2000 时应为 20U，实际 ${n2}`);
  // HYPE 价格 100：minQty 0.001 × 100 = 0.1U < 5U → 还是 5U
  assert.equal(minOrderNotional(100, HYPE), 5);
  // BTC 价格 82000：minQty 0.001 × 82000 = 82U > 50U → 取 82U
  const n3 = minOrderNotional(82000, BTC);
  assert.ok(Math.abs(n3 - 82) < 1e-6, `BTC 应为 82U，实际 ${n3}`);
  // 没有 rules 时退回默认 5U
  assert.equal(minOrderNotional(975, {}), DEFAULT_MIN_NOTIONAL);
  assert.equal(minOrderNotional(975, {}), 5);
});

test('canPlaceNotional：边界两侧判断正确', () => {
  assert.equal(canPlaceNotional(6, 975, SKHYNIX), false, '6U 在 SKHYNIX 上下不出去');
  assert.equal(canPlaceNotional(9.7, 975, SKHYNIX), false, '9.7U 还不够一个最小单位');
  assert.equal(canPlaceNotional(9.75, 975, SKHYNIX), true, '9.75U 刚好等于一个最小单位');
  assert.equal(canPlaceNotional(15, 975, SKHYNIX), true, '15U 可以');
  // HYPE：5U 是硬门槛
  assert.equal(canPlaceNotional(4.9, 100, HYPE), false);
  assert.equal(canPlaceNotional(5, 100, HYPE), true);
  // BTC：50U 门槛 vs 0.001×82000=82U，取大的
  assert.equal(canPlaceNotional(60, 82000, BTC), false, 'BTC 60U 不足一个最小单位');
  assert.equal(canPlaceNotional(82, 82000, BTC), true);
});

test('solvePlan：第一笔 6U 在 SKHYNIXUSDT 上判不可行，并给出可执行的中文提示', () => {
  // 分配资金 5.7U、firstPct 1%、20x → 第一笔名义 = 5.7 × 1% × 20 = 1.14U（远小于 9.75U）
  const plan = solvePlan({ equity: 1000, price: 975, params: p({ allocatedCapital: 6 }), rules: SKHYNIX, direction: 'long' });
  assert.equal(plan.feasible, false, '6U 分配资金在 SKHYNIX 上不可行');
  const text = (plan.notes || []).join('\n');
  assert.match(text, /最小可下单金额/, '提示必须说明最小可下单金额');
  assert.match(text, /9\.75/, `提示里应出现 9.75U，实际：${text}`);
  assert.equal(plan.minOrderNotional, 9.75, 'plan 要暴露 minOrderNotional 供前端与 engine 使用');
  assert.equal(plan.rawMinNotional, 5, '同时保留交易所原始 minNotional');
});

test('solvePlan：名义刚好够最小单位时可行', () => {
  // firstPct 1%、20x → 第一笔名义 = capital × 0.2
  // 要 9.75U → capital = 48.75U，取 50U → 10U 名义，够 1 个单位
  const plan = solvePlan({ equity: 1000, price: 975, params: p({ allocatedCapital: 50 }), rules: SKHYNIX, direction: 'long' });
  assert.equal(plan.feasible, true, '50U 分配资金应可行');
  assert.ok(plan.firstLayerNotional >= plan.minOrderNotional, '第一笔名义不能低于最小可下单金额');
});

test('solvePlan：BTCUSDT 仍按名义门槛主导（minQty 未起约束时）', () => {
  // 价格 40000、minQty 0.001 → 0.001×40000 = 40U < 50U → 门槛仍是 50U
  const plan = solvePlan({ equity: 1000, price: 40000, params: p({ allocatedCapital: 1000 }), rules: BTC, direction: 'long' });
  assert.equal(plan.minOrderNotional, 50, 'BTC 价格 40000 时最小名义由 minNotional 主导');
  assert.equal(plan.feasible, true, '分配 1000U → 第一笔 200U 名义，可行');
  assert.ok(plan.firstLayerNotional >= 50);
});

test('engine.decide：SKHYNIXUSDT 资金不足时不下单并写中文原因', () => {
  // 分配 6U + firstPct 1% + 20x → 第一笔名义 1.2U，远低于 9.75U 的最小可下单金额
  const out = decide({
    params: p({ allocatedCapital: 6 }),
    book: null,
    markPrice: 975,
    equity: 1000,
    rules: SKHYNIX,
  });
  assert.equal(out.actions.length, 0, '资金不足时不应产生任何下单动作');
  const notes = (out.notes || []).join('\n');
  assert.match(notes, /最小可下单金额/, `应给出中文原因，实际：${notes}`);
});
