/**
 * 精度规则与降精度重试的回归测试。
 *
 * 背景（2026-10-26 用户报的 -1111）：
 * 机器人跑 SKHYNIXUSDT（股票类永续，价格 ~979），事件日志里出现
 *   「执行 open long 失败：币安接口错误：Precision is over the maximum defined for this asset.」
 *
 * 根因链：
 *   1. exchangeInfo 里该合约的 contractType 是 TRADIFI_PERPETUAL（不是 PERPETUAL），
 *      而 live.js 的 getRules 里写着 `if (s.contractType !== 'PERPETUAL') continue`，
 *      于是这个合约被跳过 → 抛 NO_SYMBOL → 静默降级成兜底规则；
 *   2. 兜底规则的 stepSize 固定 0.001（3 位小数），而它真实 stepSize 是 0.01（2 位小数）；
 *   3. 名义 15U / 价 979 → qty 0.01532 → 按 0.001 floor 成 "0.015"（3 位小数）→ 超精度 → -1111。
 *
 * 这个文件把每一环都钉住，防止以后又被改回去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTradableSymbol,
  parseFilters,
  fmtQty,
  fmtPrice,
  qtyCandidates,
  precisionAttempts,
} from '../src/binance/live.js';

/* ------------------------------------------------------------------ *
 * 1. 合约筛选：不能再把股票类永续排除掉
 * ------------------------------------------------------------------ */

test('TRADIFI_PERPETUAL（股票类永续）必须被当作可交易合约', () => {
  // SKHYNIXUSDT 实测：contractType=TRADIFI_PERPETUAL, status=TRADING
  assert.equal(isTradableSymbol({ contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' }), true);
  assert.equal(isTradableSymbol({ contractType: 'PERPETUAL', status: 'TRADING' }), true);
  // 缺 contractType 的老数据也不能排除
  assert.equal(isTradableSymbol({ status: 'TRADING' }), true);
});

test('交割合约与已停止交易的合约要排除', () => {
  assert.equal(isTradableSymbol({ contractType: 'CURRENT_QUARTER', status: 'TRADING' }), false);
  assert.equal(isTradableSymbol({ contractType: 'NEXT_QUARTER', status: 'TRADING' }), false);
  assert.equal(isTradableSymbol({ contractType: 'PERPETUAL', status: 'SETTLING' }), false);
});

/* ------------------------------------------------------------------ *
 * 2. 过滤器解析：LOT_SIZE 与 MARKET_LOT_SIZE 都要看
 * ------------------------------------------------------------------ */

/** 造一个跟币安返回结构一致的合约对象 */
function makeSymbol(symbol, contractType, { lotStep, marketLotStep, tick, minQty, minNotional }) {
  const filters = [
    { filterType: 'PRICE_FILTER', tickSize: String(tick) },
    { filterType: 'LOT_SIZE', stepSize: String(lotStep), minQty: String(minQty), maxQty: '20000' },
    { filterType: 'MIN_NOTIONAL', notional: String(minNotional) },
  ];
  if (marketLotStep) {
    filters.push({ filterType: 'MARKET_LOT_SIZE', stepSize: String(marketLotStep), minQty: String(minQty) });
  }
  return { symbol, contractType, status: 'TRADING', filters };
}

test('parseFilters 解析 SKHYNIXUSDT 的真实过滤器（stepSize 0.01 / tickSize 0.01）', () => {
  const rules = parseFilters(makeSymbol('SKHYNIXUSDT', 'TRADIFI_PERPETUAL', {
    lotStep: 0.01,
    marketLotStep: 0.01,
    tick: 0.01,
    minQty: 0.01,
    minNotional: 5,
  }));
  assert.equal(rules.stepSize, 0.01, 'stepSize 必须来自交易所，不能被兜底成 0.001');
  assert.equal(rules.tickSize, 0.01);
  assert.equal(rules.minQty, 0.01);
  assert.equal(rules.minNotional, 5);
  assert.equal(rules.contractType, 'TRADIFI_PERPETUAL');
});

test('MARKET_LOT_SIZE 比 LOT_SIZE 粗时取粗的那一档（市价单按它校验）', () => {
  const rules = parseFilters(makeSymbol('TESTUSDT', 'PERPETUAL', {
    lotStep: 0.001, // 限价允许 3 位
    marketLotStep: 0.01, // 市价只允许 2 位
    tick: 0.01,
    minQty: 0.001,
    minNotional: 5,
  }));
  // 本平台开平仓都是 MARKET 单，取更粗的 0.01 才能保证不被 -1111 拒绝
  assert.equal(rules.stepSize, 0.01);
  assert.equal(rules.marketStepSize, 0.01);
});

test('没有 MARKET_LOT_SIZE 时退回 LOT_SIZE 的步长', () => {
  const rules = parseFilters(makeSymbol('BTCUSDT', 'PERPETUAL', {
    lotStep: 0.001, tick: 0.1, minQty: 0.001, minNotional: 100,
  }));
  assert.equal(rules.stepSize, 0.001);
  assert.equal(rules.tickSize, 0.1);
});

/* ------------------------------------------------------------------ *
 * 3. 核心回归：兜底规则（stepSize 0.001）下必须能自动降到 0.01
 * ------------------------------------------------------------------ */

test('回归：兜底 stepSize=0.001 时，qty 0.01532 会被自动降成 0.01（2 位小数）', () => {
  const degraded = { stepSize: 0.001, tickSize: 0.0001, minNotional: 5 };
  // 这就是用户那一单：名义 15U / 价 979.61 ≈ 0.01532
  const cands = qtyCandidates(0.01532, degraded, 979.61, 5);
  assert.deepEqual(cands, ['0.015', '0.01'], '必须先试 3 位小数，被 -1111 拒后再试 2 位');
  // 确认老的写法确实会产生非法数量
  assert.equal(fmtQty(0.01532, degraded), '0.015');
  assert.notEqual(cands[cands.length - 1], '0.015');
});

test('规则正确（stepSize=0.01）时直接给出合法数量，不做多余重试', () => {
  const rules = { stepSize: 0.01, tickSize: 0.01, minNotional: 5 };
  assert.deepEqual(qtyCandidates(0.01532, rules, 979.61, 5), ['0.01']);
});

test('降精度只在名义仍够最小下单额时才给出更小的候选', () => {
  const rules = { stepSize: 0.001, tickSize: 0.01, minNotional: 5 };
  // 名义 6U / 价 979 → qty 0.0061 → 0.006（名义 5.87U，够）；再降到 0 位就只剩 0，直接停
  const cands = qtyCandidates(0.0061, rules, 979, 5);
  assert.deepEqual(cands, ['0.006']);
  // 名义本来就在 5U 边缘：0.005（4.9U）已经不够最小下单额，不应再往下试
  const tight = qtyCandidates(0.00531, rules, 979, 5);
  assert.deepEqual(tight, [], '名义不足最小下单额时应当直接判失败，而不是发出必然被拒的单');
});

/* ------------------------------------------------------------------ *
 * 4. 条件单（止盈/止损）的数量与触发价一起降精度
 * ------------------------------------------------------------------ */

test('条件单：数量与触发价同步逐档降精度', () => {
  const degraded = { stepSize: 0.001, tickSize: 0.0001 };
  const attempts = precisionAttempts(degraded, { qty: 0.01532, triggerPrice: 986.9612 });
  assert.ok(attempts.length >= 2);
  assert.equal(attempts[0].quantity, '0.015');
  assert.equal(attempts[0].stopPrice, '986.9612');
  // 第 2 档：数量 2 位小数（0.01），触发价 3 位小数（986.961）
  assert.equal(attempts[1].quantity, '0.01');
  assert.equal(attempts[1].stopPrice, '986.961');
});

test('条件单：真实规则下只产生一档', () => {
  const rules = { stepSize: 0.01, tickSize: 0.01 };
  const attempts = precisionAttempts(rules, { qty: 0.01532, triggerPrice: 986.9612 });
  assert.deepEqual(attempts, [{ quantity: '0.01', stopPrice: '986.96' }]);
});

test('数量归 0 时条件单不产生任何档位（调用方应报错而不是发单）', () => {
  const rules = { stepSize: 1, tickSize: 0.01 };
  assert.deepEqual(precisionAttempts(rules, { qty: 0.5, triggerPrice: 979 }), []);
});

/* ------------------------------------------------------------------ *
 * 5. 价格精度
 * ------------------------------------------------------------------ */

test('fmtPrice 按 tickSize 四舍五入，且不会多写小数位', () => {
  assert.equal(fmtPrice(979.6134, { tickSize: 0.01 }), '979.61');
  assert.equal(fmtPrice(979.6134, { tickSize: 0.1 }), '979.6');
  assert.equal(fmtPrice(78.4562, { tickSize: 0.001 }), '78.456');
  // 兜底 tick 0.0001 时确实会产生 4 位小数（这就是旧 bug 里价格也被拒的原因）
  assert.equal(fmtPrice(979.6134, { tickSize: 0.0001 }), '979.6134');
});

/* ------------------------------------------------------------------ *
 * 6. 各种 stepSize 的边界
 * ------------------------------------------------------------------ */

test('stepSize=1 的合约（整数数量）能正确取整', () => {
  assert.equal(fmtQty(15.7, { stepSize: 1 }), '15');
  assert.equal(fmtQty(0.9, { stepSize: 1 }), '0');
});

test('stepSize 用科学计数法表示时也能算对小数位', () => {
  // 某些小币种 stepSize 是 1e-7 这种
  assert.equal(fmtQty(0.000012345, { stepSize: 1e-7 }), '0.0000123');
});
