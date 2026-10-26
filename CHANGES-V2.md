# 本轮改造契约（2026-10-26 第二轮）

> 这份文件是三位开发者（lead / strategy / frontend2）共同遵守的接口约定。
> 只写「改什么、叫什么名字、谁负责」，不写实现细节。
> 改之前先读自己负责那一节，别动别人那一节的文件。

## 用户提出的 13 条问题 → 归属

| # | 问题 | 归属 | 状态 |
|---|---|---|---|
| 1 | 下单遇到网络问题会重复创建 | lead（live.js + runner.js） | 代码已改 |
| 2 | 数量/价格精度超出资产定义（-1111/-4164） | lead（live.js） | 代码已改 |
| 3 | 机器人要用「分配给自己的资金」而不是全账户资金 | strategy + lead | 待改 |
| 4 | 第一笔名义低于币安最小 5U 要拦住 | strategy | 待改 |
| 5 | 双向持仓下不能传 reduceOnly（-1106） | lead（live.js） | 代码已改 |
| 6 | 每 5 秒整页刷新导致滚动条复位，要局部刷新 | frontend2 | 待改 |
| 7 | 计划表里的加仓价/均价/止损一直在变，要锚定 | strategy | 待改 |
| 8 | 代理链路导致 recvWindow 超时 | lead（config.js + rest.js） | 代码已改 |
| 9 | 停止机器人时可选择是否平仓 | lead（runner.js + routers/robots.js） | 待改 |
| 10 | 机器人开的仓在币安上没有止盈止损挂单 | lead（runner.js + live.js） | 待改 |
| 11 | 「新增 API Key」按钮实际是修改，文案要改 | frontend2 | 待改 |
| 12 | 只有一种主题，要可自定义主题 | frontend2 | 待改 |
| 13 | 时间戳以币安服务器为准 | lead（rest.js） | 代码已改 |

## 统一的参数约定（strategy 负责）

`src/strategy/params.js` 的 `PARAM_SCHEMA` 增加第 13 个参数：

```js
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
}
```

- `LEGACY_MAP` 里补 `initialCapital: 'allocatedCapital'`。
- `normalizeParams` 保证 `allocatedCapital` 是 ≥5 的数字。
- `validateParams` 增加一条**硬错误**：
  - `firstNotional = (allocatedCapital * firstPct / 100) * leverage`
  - 若 `firstNotional < 5`，errors 里加：`第一笔名义只有 X.XXU，低于币安最小下单额 5U。请把「分配给这个机器人的资金」调大，或把「第一笔保证金占权益比例」调大，或提高杠杆。`
  - 若 `firstNotional > allocatedCapital * leverage`（第一笔就吃满），已在旧规则里，保留。

## 计划锚定约定（strategy 负责）

`src/strategy/solver.js` 的 `solvePlan({ equity, price, params, rules, direction, currentLayers, atrPct, anchorPrice })`：

- **资金基数**：`capital = Number(params.allocatedCapital) > 0 ? Number(params.allocatedCapital) : Number(equity)`。
  所有 `firstMargin = capital * firstPct/100`、`capTotal = capital * totalPct`、`lossBudget = capital * maxLossPct/100`
  全部用 `capital`，**不再用账户权益**。plan 里输出 `capital` 字段。
- **价格锚点**：`const anchor = Number(anchorPrice) > 0 ? Number(anchorPrice) : Number(price)`。
  阶梯里的 `longTriggerPrice/shortTriggerPrice` 全部以 `anchor` 为基准（第 i 笔 = `anchor*(1-gap)^i`），
  这样计划表在行情波动时不会整体漂移；只有「当前该盯的止盈/止损」跟实际均价走。
  plan 里输出 `anchorPrice: anchor`。
- plan 顶层增加 `firstMarginUsd`（第一笔保证金，USDT）与 `minNotional`（交易所最小名义，默认 5）。

## 停止机器人（lead 负责）

`POST /api/robots/:id/stop` body 变成 `{ closePositions?: boolean }`：

- `closePositions === true` → 先平掉**这个机器人自己账本里的**仓位（paper：`closeSide` 两边全平；
  live：按 `liveLegs` 的数量下 reduceOnly 市价单，并撤销该机器人自己挂的条件单），再停机。
- `false` 或缺省 → 只停定时器，仓位留在交易所（下一轮启动会自动接管）。
- 事件文案区分两种情况，返 `{ closed: [...], closedCount }`。

## 实盘止盈止损挂单（lead 负责）

机器人每开一笔（或平仓改变数量）后，用 `liveLegs` 的实际持仓量与均价重算目标价：

- 多：TP = 均价×(1+tpPct/100)，SL = 均价×(1-stopPct/100)（经 `safeStop` 夹在 entry 与 liq 之间）
- 空：TP = 均价×(1-tpPct/100)，SL = 均价×(1+stopPct/100)
- 用 `live.js` 的 `placeConditional()` 挂 `TAKE_PROFIT_MARKET` / `STOP_MARKET`，
  `positionSide` + `quantity = 机器人自己那份`（绝不用 closePosition，会平掉用户手动仓）。
- 旧的条件单按 `state_json.condOrders` 里记的 clientOrderId 撤掉再挂新的。
- 止盈方式是「逐笔止盈（layer）」时，每笔 leg 各挂一对（数量=该笔数量）；
  「整体止盈（avg）」时按整边合计挂一对。

## 前端约定（frontend2 负责）

1. **局部刷新**：机器人详情与账户页不允许再整块 `innerHTML` 重建。
   新增 `patchText(root, selector, text)` / `patchChart(selector, data)` 之类的工具，
   只更新数字与图表。表格如果行数/顺序不变就只改单元格；行数变了才重建（并保留 `scrollTop`）。
   所有 `setInterval` 轮询都要经过 `pollRegion()`，写入前记录并恢复滚动位置。
2. **停止弹窗**：点「停止」弹确认框，两个按钮「停止但保留仓位」「停止并平掉本机器人仓位」。
3. **API Key 文案**：`新增 API Key` → `修改 API Key`（已有则显示「修改」）；页面标题同步。
4. **主题**：顶部导航加主题切换；至少 4 套：`dark`（默认深色）/ `light` / `blue`（偏冷）/ `warm`（暖色）。
   用 CSS 变量实现（`--bg / --panel / --text / --muted / --green / --red / --accent`），
   存 `localStorage.theme`，`document.documentElement.dataset.theme = name`。
   不允许在 JS 里硬编码颜色。
5. **资金字段**：机器人创建/编辑表单里 `allocatedCapital` 会自动从 schema 渲染出来，不用特殊处理；
   但机器人卡片与详情页要显示「分配资金 X U / 已占用 Y U」。

## 验收

- `node scripts/check.js` 全绿、`node --test scripts/*.mjs` 全绿。
- 本地 paper 机器人跑 60 秒：只开 2 笔、不重复开、计划表价格不动、停止可选平仓生效。
- 打包 `biance_trae.tar.gz` 交给用户自己部署。
