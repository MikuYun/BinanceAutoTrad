import test from 'node:test';
import assert from 'node:assert/strict';

import { decide } from '../src/strategy/engine.js';
import { normalizeParams } from '../src/strategy/params.js';
import { solvePlan } from '../src/strategy/solver.js';

const RULES = { minNotional: 5, stepSize: 0.001, tickSize: 0.0001 };

function p(over = {}) {
  return normalizeParams({
    direction: 'dual',
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

test('仓位尺寸按 allocatedCapital 算，不按账户权益（问题 #3）', () => {
  // 账户 1000U，只分配给机器人 100U → 第一笔名义 = 100 × 1% × 20 = 20U
  const plan = solvePlan({ equity: 1000, price: 100, params: p(), rules: RULES, direction: 'dual' });
  assert.equal(plan.capital, 100, '资金基数必须是分配资金');
  assert.equal(plan.firstLayerNotional, 20, '第一笔名义按分配资金算');
  assert.equal(plan.firstLayerMargin, 1);

  // 分 300U → 第一笔名义 60U
  const plan2 = solvePlan({ equity: 1000, price: 100, params: p({ allocatedCapital: 300 }), rules: RULES, direction: 'dual' });
  assert.equal(plan2.firstLayerNotional, 60);
});

test('分配资金太小导致首笔低于最小下单额时，直接判不可行并给出中文原因（问题 #4）', () => {
  const plan = solvePlan({ equity: 1000, price: 100, params: p({ allocatedCapital: 20 }), rules: RULES, direction: 'dual' });
  assert.equal(plan.feasible, false);
  assert.match(plan.notes.join('\n'), /最小下单额/);
});

test('加仓时累计占用不能超过分配资金（问题 #3 的加仓闸）', () => {
  const params = p({
    allocatedCapital: 100, firstPct: 1, leverage: 20,
    growRatio: 1.2, spacingPct: 1, maxLayers: 6, totalPct: 10, maxLossPct: 60,
  });
  // 造一个已经占用 99U 保证金的多单账本（5 笔 × 19.8U，均价约 98）
  const legs = [];
  for (let i = 0; i < 5; i += 1) {
    const entry = 100 * (1 - 0.01) ** i;
    const margin = 19.8;
    legs.push({ id: 'l' + i, qty: (margin * 20) / entry, entryPrice: entry, margin, layer: i + 1 });
  }
  const book = { walletBalance: 10000, positions: { long: legs, short: [] } };
  // 价格 97 触发第 6 笔加仓（加仓线约 97.03），第 6 笔要 2.49U 保证金
  // 已占用 99U → 99 + 2.49 > 100，必须被拦
  const r = decide({ params, book, markPrice: 97, equity: 1000, rules: RULES });
  const opens = r.actions.filter((a) => a.type === 'open' && a.side === 'long');
  assert.equal(opens.length, 0, '超过分配资金的加仓必须被拦下');
  assert.match(r.notes.join(String.fromCharCode(10)), /超过分配资金/);
});

test('价格往下走会加仓，加仓后均价被摊低', () => {
  const params = p({ allocatedCapital: 1000, firstPct: 1, leverage: 20, growRatio: 1, spacingPct: 1, maxLayers: 5, totalPct: 10, maxLossPct: 60 });
  const book = {
    walletBalance: 10000,
    positions: { long: [{ id: 'a', qty: 200 / 100, entryPrice: 100, margin: 10, layer: 1 }], short: [] },
  };
  const r = decide({ params, book, markPrice: 98.9, equity: 10000, rules: RULES });
  const opens = r.actions.filter((a) => a.type === 'open' && a.side === 'long');
  assert.equal(opens.length, 1, '跌过 1% 应该加一笔');
  assert.equal(opens[0].layer, 2);
  assert.equal(opens[0].notional, 200, '第一笔名义 1000×1%×20=200');
});

test('价格没走到加仓线时不加仓（层数不会一上来就满）', () => {
  const params = p({ allocatedCapital: 1000, firstPct: 1, leverage: 20 });
  const book = {
    walletBalance: 10000,
    positions: { long: [{ id: 'a', qty: 2, entryPrice: 100, margin: 10, layer: 1 }], short: [] },
  };
  const r = decide({ params, book, markPrice: 99.5, equity: 10000, rules: RULES });
  const opens = r.actions.filter((a) => a.type === 'open');
  assert.equal(opens.filter((a) => a.layer > 1).length, 0);
});

test('计划锚点固定时，同一 anchorPrice 产出的阶梯完全一致（问题 #7）', () => {
  const params = p({ allocatedCapital: 1000 });
  const a = solvePlan({ equity: 10000, price: 90, params, rules: RULES, direction: 'dual', anchorPrice: 100 });
  const b = solvePlan({ equity: 10000, price: 105, params, rules: RULES, direction: 'dual', anchorPrice: 100 });
  assert.equal(a.anchorPrice, 100);
  assert.equal(b.anchorPrice, 100);
  assert.deepEqual(
    a.layerList.map((x) => x.entryPrice),
    b.layerList.map((x) => x.entryPrice),
    '现价变了但锚点没变，阶梯触发价必须一样',
  );
});
