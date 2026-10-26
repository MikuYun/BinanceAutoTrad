/**
 * 参数定义与校验。
 *
 * 设计原则（用户明确要求）：
 *  1. 每一个参数都必须是**能用一句人话解释清楚**的，不需要看公式。
 *  2. 金额一律用「百分比」表达，不出现 β / kMax / ATR 这类字母黑话。
 *  3. 旧参数名保留映射，历史机器人不需要重建也能继续跑。
 *
 * 旧 → 新 映射（normalizeParams 里自动转换）：
 *   k        → firstPct     第一笔保证金占分配资金%
 *   beta     → spacingPct   （旧的是 β×ATR，无法还原成固定百分比，按 1% 兜底）
 *   kMax     → totalPct     单方向总投入上限（分配资金倍数）
 *   dMax     → maxLossPct   满仓最大浮亏%
 *   stopAtr  → stopPct      止损幅度%（旧语义不同，按 5% 兜底）
 *   growRatio 旧无此参数，默认按 1.5 兜底
 *   initialCapital → allocatedCapital  旧机器人的本金就是「分配给它的资金」
 */

/** 参数 schema：前端表单直接按这个渲染 */
export const PARAM_SCHEMA = [
  {
    key: 'direction',
    label: '交易方向',
    group: '基础',
    type: 'select',
    default: 'dual',
    options: [
      { value: 'dual', label: '双向（同时做多和做空）' },
      { value: 'long', label: '只做多（跌了加仓、反弹止盈）' },
      { value: 'short', label: '只做空（涨了加仓、回落止盈）' },
    ],
    help: '双向时价格上下波动两头都能吃；只做多只在下跌加仓、反弹止盈；只做空只在上涨加仓、回落止盈。',
  },
  {
    key: 'allocatedCapital',
    label: '分配给这个机器人的资金（USDT）',
    group: '资金',
    type: 'number',
    default: 100,
    min: 5,
    max: 10000000,
    step: 5,
    help: '这个机器人最多能占用多少钱，不会动用账户里其余的钱。'
      + '第一笔保证金、每笔加仓、单方向上限、最坏亏损全部按这个数字算，与账户总资金无关。',
  },
  {
    key: 'firstPct',
    label: '第一笔保证金占分配资金的比例（%）',
    group: '下单金额',
    type: 'percent',
    default: 1,
    min: 0.1,
    max: 20,
    step: 0.1,
    help: '例：分配资金 100U、填 1，第一笔就占用 1U 保证金（20 倍杠杆时成交 20U 的仓位）。',
  },
  {
    key: 'leverage',
    label: '杠杆倍数',
    group: '下单金额',
    type: 'number',
    default: 20,
    min: 1,
    max: 125,
    step: 1,
    help: '交易所全仓杠杆。杠杆越高，同样保证金能开的仓位越大，但强平也越近。',
  },
  {
    key: 'growRatio',
    label: '每加一次仓，金额是上一次的几倍',
    group: '加仓规则',
    type: 'number',
    default: 1.5,
    min: 1,
    max: 5,
    step: 0.1,
    help: '填 1 表示每次加同样多的钱（最稳）；填 1.5 表示每次加仓比上次多 50%（摊低均价更快，但后段仓位很重）。',
  },
  {
    key: 'spacingPct',
    label: '加仓间距（%）',
    group: '加仓规则',
    type: 'percent',
    default: 1,
    min: 0.2,
    max: 10,
    step: 0.1,
    help: '价格朝不利方向每走这么多，就加一次仓。例：填 1，做多的单子价格跌 1% 加一次。',
  },
  {
    key: 'maxLayers',
    label: '最多加仓几次（层数上限）',
    group: '加仓规则',
    type: 'number',
    default: 6,
    min: 1,
    max: 30,
    step: 1,
    help: '从第一笔开始算，最多一共开几笔。到顶之后只等止盈或止损，不再加仓。',
  },
  {
    key: 'totalPct',
    label: '单方向最多投入多少钱（分配资金的几倍）',
    group: '风险控制',
    type: 'number',
    default: 3,
    min: 0.5,
    max: 20,
    step: 0.5,
    help: '这里说的是「仓位名义价值」。填 3 表示一边最多开到分配资金的 3 倍；20 倍杠杆下实际占用保证金约 15%。',
  },
  {
    key: 'maxLossPct',
    label: '全部加满时，最多能亏分配资金的百分之几',
    group: '风险控制',
    type: 'percent',
    default: 35,
    min: 5,
    max: 90,
    step: 1,
    help: '求解器会用这个上限反过来砍层数：如果加满后跌到止损位亏得比它多，就少加几层。',
  },
  {
    key: 'tpMode',
    label: '止盈方式',
    group: '止盈止损',
    type: 'select',
    default: 'avg',
    options: [
      { value: 'avg', label: '整体止盈（价格回到持仓均价上方就走）' },
      { value: 'layer', label: '逐笔止盈（每一笔各自到价就走）' },
    ],
    help: '「整体止盈」是先扛、靠加仓把均价摊低，等价格回到均价上方一起平掉——和你手动交易的做法一致。',
  },
  {
    key: 'tpPct',
    label: '止盈幅度（%）',
    group: '止盈止损',
    type: 'percent',
    default: 0.5,
    min: 0.05,
    max: 10,
    step: 0.05,
    help: '整体止盈时，价格要比「当前持仓均价」高这么多才平仓。例：均价 100、填 0.5，价格到 100.5 就平。手续费来回约 0.1%，别填太小。',
  },
  {
    key: 'stopPct',
    label: '止损幅度（%）',
    group: '止盈止损',
    type: 'percent',
    default: 5,
    min: 0.5,
    max: 50,
    step: 0.5,
    help: '价格相对「当前持仓均价」反向走这么多，就把这一边全部平掉认亏，避免被强平。',
  },
  {
    key: 'interval',
    label: '每多久判断一次',
    group: '运行',
    type: 'select',
    default: '5m',
    options: [
      { value: '1m', label: '1 分钟' },
      { value: '5m', label: '5 分钟' },
      { value: '15m', label: '15 分钟' },
      { value: '1h', label: '1 小时' },
    ],
    help: '机器人每隔这么久看一次价格并决定要不要加仓/平仓。实际下单检查是每 5 秒一轮，这里只决定用哪条周期的数据做参考。',
  },
];

/** 默认参数 */
export const DEFAULT_PARAMS = PARAM_SCHEMA.reduce((acc, f) => {
  acc[f.key] = f['default'];
  return acc;
}, {});

/** 旧参数名 → 新参数名的兜底值 */
const LEGACY_MAP = {
  k: (v) => Number(v),
  beta: () => 1,
  kMax: (v) => Number(v),
  dMax: (v) => Number(v),
  stopAtr: () => 5,
  maxLayers: (v) => Number(v),
  direction: (v) => v,
  leverage: (v) => Number(v),
  interval: (v) => v,
  tpMode: (v) => v,
  // 旧机器人的 initialCapital 语义就是「分给这个机器人的本金」，直接接到 allocatedCapital
  initialCapital: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  },
};

export const INTERVALS = ['1m', '5m', '15m', '1h'];

/** 分配资金的合法区间（USDT）。上限与 schema 里的 max 保持一致。 */
export const MIN_ALLOCATED_CAPITAL = 5;
export const MAX_ALLOCATED_CAPITAL = 10000000;

/** 币安 U 本位永续的最小下单名义（USDT）。交易所返回的规则优先，这里只是兜底。 */
export const DEFAULT_MIN_NOTIONAL = 5;

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** 取单个参数定义 */
export function getParamSpec(key) {
  return PARAM_SCHEMA.find((f) => f.key === key) || null;
}

/**
 * 归一化：把任意历史参数对象转成新 schema 的完整参数。
 * 旧键自动映射，缺的走默认值，超出范围的夹到合法区间。
 */
export function normalizeParams(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_PARAMS };

  // 1. 旧键映射（只在没有新键时生效）
  const legacy = {
    k: 'firstPct',
    beta: 'spacingPct',
    kMax: 'totalPct',
    dMax: 'maxLossPct',
    stopAtr: 'stopPct',
    initialCapital: 'allocatedCapital',
  };
  for (const [oldKey, newKey] of Object.entries(legacy)) {
    if (src[newKey] == null && src[oldKey] != null) {
      const mapped = LEGACY_MAP[oldKey](src[oldKey]);
      if (mapped != null) out[newKey] = mapped;
    }
  }

  // 2. 直接覆盖
  for (const f of PARAM_SCHEMA) {
    if (src[f.key] == null) continue;
    if (f.type === 'select') {
      const ok = (f.options || []).some((o) => String(o.value) === String(src[f.key]));
      if (ok) out[f.key] = String(src[f.key]);
    } else if (f.type === 'number' || f.type === 'percent') {
      out[f.key] = clamp(num(src[f.key], f['default']), f.min, f.max);
    }
  }

  // 3. 兜底规整
  out.direction = ['long', 'short', 'dual'].includes(String(out.direction))
    ? String(out.direction)
    : 'dual';
  // 分配资金：永远是一个 ≥5 的有限数字（旧 initialCapital 映射过来也在这里夹一遍）
  out.allocatedCapital = clamp(
    num(out.allocatedCapital, DEFAULT_PARAMS.allocatedCapital),
    MIN_ALLOCATED_CAPITAL,
    MAX_ALLOCATED_CAPITAL,
  );
  out.tpMode = out.tpMode === 'layer' ? 'layer' : 'avg';
  out.interval = INTERVALS.includes(out.interval) ? out.interval : '5m';
  out.maxLayers = Math.round(out.maxLayers);
  out.leverage = Math.round(out.leverage);
  out.allocatedCapital = Number(out.allocatedCapital.toFixed(2));
  out.firstPct = Number(out.firstPct.toFixed(4));
  out.spacingPct = Number(out.spacingPct.toFixed(4));
  out.growRatio = Number(out.growRatio.toFixed(3));
  out.totalPct = Number(out.totalPct.toFixed(3));
  out.maxLossPct = Number(out.maxLossPct.toFixed(2));
  out.tpPct = Number(out.tpPct.toFixed(4));
  out.stopPct = Number(out.stopPct.toFixed(4));
  return out;
}

/**
 * 组合校验：只看单个参数范围之外，还要检查互相之间有没有矛盾。
 * 返回 { ok, errors:[], warnings:[], params }
 *
 * 注意：这里的「资金」一律指 allocatedCapital（分给这个机器人的钱），
 * 不再指账户权益 —— 换了资金基数以后，同一组参数在大小账户上的结论必须一致。
 *
 * @param {object} params 原始参数（内部会先 normalize）
 * @param {object} [opts]
 * @param {number} [opts.minNotional] 交易所最小名义，缺省 5U
 */
export function validateParams(params, opts = {}) {
  const p = normalizeParams(params);
  const errors = [];
  const warnings = [];

  const minNotional = Number(opts.minNotional) > 0
    ? Number(opts.minNotional)
    : DEFAULT_MIN_NOTIONAL;

  const firstMargin = (p.allocatedCapital * p.firstPct) / 100;
  const firstNotional = firstMargin * p.leverage;
  const firstNotionalPct = (p.firstPct / 100) * p.leverage * 100; // 第一笔名义占分配资金%

  // 硬错误 0：第一笔名义连币安最小下单额都不到，开不出来。
  // 用 rounded 到 2 位再比，避免 4.999999 这种浮点误差被当成长度不足。
  if (Number(firstNotional.toFixed(2)) < minNotional) {
    errors.push(
      `第一笔名义只有 ${firstNotional.toFixed(2)}U，低于币安最小下单额 ${minNotional}U。`
        + '请把「分配给这个机器人的资金」调大，或把「第一笔保证金占分配资金的比例」调大，或提高杠杆。',
    );
  }
  if (firstNotionalPct > 400) {
    errors.push(
      `第一笔仓位太重：${p.firstPct}% 保证金 × ${p.leverage} 倍杠杆 = 分配资金的 ${firstNotionalPct.toFixed(0)}%。`
        + '请把「第一笔保证金占比」降到 1% 以下，或降低杠杆。',
    );
  }
  if ((p.firstPct / 100) * p.leverage > p.totalPct) {
    errors.push(
      `第一笔就超过了「单方向总投入上限」：第一笔名义占分配资金 ${firstNotionalPct.toFixed(0)}%，`
        + `而上限只有 ${p.totalPct} 倍。请调大总投入上限或调小第一笔。`,
    );
  }
  if (p.tpPct * 2 <= 0.12) {
    warnings.push(
      `止盈幅度 ${p.tpPct}% 太小：币安永续来回手续费约 0.1%，扣除后基本没利润。建议 0.3% 以上。`,
    );
  }
  if (p.stopPct <= p.spacingPct) {
    warnings.push(
      `止损幅度 ${p.stopPct}% 不大于加仓间距 ${p.spacingPct}%，可能第一笔刚开就触发止损。建议止损 ≥ 间距的 3 倍。`,
    );
  }
  if (p.growRatio > 2) {
    warnings.push(
      `每层加仓 ${p.growRatio} 倍，后段仓位会非常集中。请确认层数上限不要设太高。`,
    );
  }
  return { ok: errors.length === 0, errors, warnings, params: p };
}

/** 给前端 meta 用 */
export function paramsMeta() {
  return {
    schema: PARAM_SCHEMA,
    defaults: { ...DEFAULT_PARAMS },
  };
}
