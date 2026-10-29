# 事故复盘与改造方案：实盘机器人重复开仓 / 账本归零

| 项 | 内容 |
|---|---|
| 事故时间 | 2026-10-29 08:02–08:08（Asia/Shanghai） |
| 影响机器人 | `r_1673cc03a2ed490b861cae0103cedb43`（"Skhynix实盘"，SKHYNIXUSDT，live 模式） |
| 直接后果 | 交易所真实持仓被加到 **0.7 张**，机器人账本 **0 张**、层数显示 **0**，最终机器人被停止 |
| 错误签名 | `执行 open long 失败：UNIQUE constraint failed: orders.client_id`（36 次）<br>`执行 close long 失败：UNIQUE constraint failed: orders.client_id`（1 次） |
| 性质 | **状态机被异常打断导致的重复下单**，不是下单接口故障 |
| 代码位置 | `src/binance/live.js`、`src/strategy/runner.js` |

---

## 一、结论摘要

`makeClientId()` 用「5 分钟时间桶」生成**确定性**的 `clientOrderId`。同一桶内二次开仓时 id 完全相同，这个 id 撞上本地 `orders.client_id` 的 `UNIQUE` 约束后，**异常在「写入机器人账本」之前抛出**并被 `catch` 吞掉，账本因此永远不前进；下一 tick 策略仍认为"未建仓"，于是再次发出真实市价单 —— 而币安对**已成交**市价单的同 id 重发**照单接受并成交**。

结果：每 5 秒真实成交一笔，本地一条记录都写不进去，形成死循环。

> **止损单/网络超时**：`recvWindow`/时间戳抖动（96 次 `Timestamp ... ahead of the server's time`）会整 tick 跳过决策，与本次事故无直接因果，但会放大行情错位窗口。
>
> **止损缺失**：`placeConditional()` 使用的 `/fapi/v1/order` 端点已被币安拒绝（`Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.`），事故期间交易所侧**没有任何止损单**，属独立的严重风险，见 P1-1。

---

## 二、事故链路（逐步对应代码与线上数据）

| 步 | 事件 | 代码位置 |
|---|---|---|
| 1 | 08:05:00 开第 1 层，`clientOrderId = btcedb43l1op3k481`，成交 0.023021 张 @1141.83，**记账成功** | `src/strategy/runner.js:490` → `:492` |
| 2 | 08:07:03 整体止盈平仓，`clientOrderId = btcedb43l0cl3k481`，记账成功 | `src/strategy/runner.js:540` → `:555` |
| 3 | 策略重新计算计划，判定需**重建第一层**；此时仍处在同一个 5 分钟桶（08:05:00–08:10:00 → `k481`） | `src/binance/live.js:291` |
| 4 | `makeClientId()` 生成**与步骤 1 完全相同**的 id，向币安下单，**成交** | `src/binance/live.js:401` |
| 5 | 回到本地 `recordOrder()` 用同一 clientId 执行 `INSERT` → 撞 `orders.client_id UNIQUE` → **抛异常** | `src/strategy/runner.js:492` / `:81` |
| 6 | 异常发生在 `addLeg(legs, ...)` **之前**，`liveLegs` 仍为空 | `src/strategy/runner.js:502` |
| 7 | `catch` 只写一条 error 事件，循环继续下一 tick | `src/strategy/runner.js:575-577` |
| 8 | 下一 tick：账本为空 → 判定"建第一笔 / 第 1 层" → 回到步骤 4 | 循环体 |

### 相关源码片段

`src/binance/live.js:291-298` —— 确定性 id 的生成（问题源头）：

```js
export function makeClientId(robotId, side, layer, action, bucketMs = 300000) {
  const rb = String(robotId).replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'r';
  const sd = String(side || 'x').slice(0, 1).toLowerCase();
  const act = String(action || 'ord').replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'or';
  const lay = Math.max(0, Math.min(999, Number(layer) || 0));
  const bucket = Math.floor(Date.now() / Math.max(1000, bucketMs)).toString(36);
  return `bt${rb}${sd}${lay}${act}${bucket}`.slice(0, 36);
}
```

`src/strategy/runner.js:480-516` —— 实盘开仓：**先记账、后建账本**（顺序是致命的）：

```js
const res = await exchange.placeOrder(creds, {
  symbol, side, positionSide, type: 'MARKET', quantity: qty, price, rules,
  clientOrderId: makeClientId(robotId, act.side, act.layer, 'op'),   // :490
});
recordOrder(userId, robotId, symbol, {          // :492  ← 这里抛，后面全部跳过
  ...
  clientId: res.clientOrderId,
});
// 记进机器人自己的账本，之后只认这几笔
addLeg(legs, act.side, { ... });                // :502  ← 永远执行不到
```

`src/strategy/runner.js:77-103` —— `recordOrder()` 直接 `INSERT`，唯一键冲突即抛：

```js
function recordOrder(userId, robotId, symbol, o) {
  const id = randomId('o');
  run(`INSERT INTO orders (...) VALUES (...)`, id, userId, robotId,
      o.clientId || id, ...);          // client_id UNIQUE，冲突即 throw
  return id;
}
```

---

## 三、为什么"防重复"机制反而放大了事故

`makeClientId` 的设计意图（原注释即如此）：同一桶内重发同一个 id，币安按 `-4116 ClientOrderId is duplicated` 拒单，代码再走 `isDuplicateError → recoverByClientId` 回查，认定为"已下单"。

**这个前提不成立：**

- 币安对 `newClientOrderId` 的去重只约束**仍在挂单中**的订单；
- `MARKET` 单是即时成交的，一旦 `FILLED`，同一 `clientOrderId` 再发会被**接受并再成交一笔**。

线上证据：仓位按每 tick **恰好 +0.02 张**（0.02 = 该合约 `stepSize` 规整后的单笔量）递增，而不是报 `-4116`。

> **确定性 id 的"幂等"作用完全失效，而"同 id 必撞本地唯一约束"却 100% 生效。**
> 等于把"防重复下单"变成了"每 5 秒确认重复下单一次"。

另外 `src/binance/rest.js` 文件头注释写着：

> "下单 POST /fapi/v1/order 绝不自动重试，防重复由 clientOrderId 幂等 **+ 下单前查重** 解决"

但代码里**没有任何"下单前查重"逻辑**。注释描述的是一个不存在的保护。

---

## 四、"服务器建仓失败、交易所却成功"的原因

异常位置在**下单之后、记账之时**：

- 交易所侧：`placeOrder` 调用成功 → 已成交；
- 本地侧：`recordOrder` 的 `INSERT` 抛错 → 无 `orders` 记录、无 `liveLegs` 记录。

所以"失败"是**本地记账失败**，交易所侧是**真实成功**。用户界面上看到的错误、层数为 0，都是本地状态的投影，与真实持仓背离。

---

## 五、三个次生缺陷（同一病根）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 平仓也用 `makeClientId(robotId, act.side, 0, 'cl')`，层号写死 `0`（`runner.js:540`） | 同一 5 分钟桶内第二次平仓**必撞同一个 id**（08:03:21 那次 `close long` UNIQUE 即此） |
| 2 | 平仓路径**顺序相反**：先 `drainLegs/drainQty` 改账本（`runner.js:546-549`），再 `recordOrder()`（`:555`） | 记账抛错时变成"交易所没平 / 账本已平"，与开仓方向正好相反，两头都错 |
| 3 | `catch` 只 `logEvent`，不中断、不熔断（`runner.js:575-577`） | 实盘场景下任何未预期异常都会退化成"每 5 秒重发一次真单"的死循环 |

---

## 六、一个更隐蔽的连带后果

错误集中爆发在 08:05–08:10 这一个桶内。**如果机器人没有被手动停止**，08:10 换桶后 id 就变了，`INSERT` 会成功 → 账本只记上最后那一笔 0.02 张，而交易所是 0.72 张。随后 `reconcile()` 会把差额当作"用户手动仓"，按设计**永久不动它**（`src/strategy/liveBook.js` 的 `baseline` 机制），机器人从此在该标的上永久跑偏。

---

## 七、数据证据（线上只读取证）

### 7.1 `orders` 表（该机器人，倒序）

```
08:07:03  btcedb43l0cl3k481  SELL  0.023021   整体止盈（均价 1141.8300 +0.75% → 1150.3937）
08:05:00  btcedb43l1op3k481  BUY   0.023021   建第一笔
08:02:55  btcedb43l1op3k480  BUY   0.023132   建第一笔
08:02:50  btcedb43l0cl3k480  SELL  0.12       整体止盈（均价 1124.5235 +0.75% → 1132.9575）
```

**08:07 之后 `orders` 表没有任何新记录**，但交易所仓位从 0.36 → 0.70 张。

### 7.2 事件流（08:00–09:00）

- `执行 open long 失败：UNIQUE constraint failed: orders.client_id` —— **36 次**，最后一次 08:08:40
- `执行 close long 失败：UNIQUE constraint failed: orders.client_id` —— 1 次，08:03:21
- `检测到 多单有 0.XXXXXX 张非机器人仓位（手动仓），机器人不会动它` —— 每 5 秒一条，从 0.020000 递增到 **0.700000**
- 08:08:42 `机器人已停止`

### 7.3 机器人 `state_json`（停止后）

```json
{
  "equity": 238.715,
  "balance": 128.1646,
  "realizedPnl": 2.7850079848197615,
  "initialEquity": 256.5976,
  "positions": {
    "long": [{
      "symbol": "SKHYNIXUSDT", "qty": 0.7, "entryPrice": 1145.1094285714285,
      "markPrice": 1146.72493703, "liqPrice": 971.56066156,
      "leverage": 50, "marginType": "cross",
      "layers": 1, "ownQty": 0, "manualQty": 0.7
    }]
  },
  "liveLegs": []
}
```

**交易所 0.7 张 / 账本 0 张 / 层数 0** —— 与用户描述完全一致。

### 7.4 合约精度（`data/rules-cache.json`）

`SKHYNIXUSDT stepSize=0.01`, `tickSize=0.01`, `minNotional=5` → 每笔开仓数量被规整为 0.02，与事件流"每次 +0.02"精确吻合，证明**每次重试都是真实成交**。

---

## 八、改造方案

分三层：**P0 必须改**（否则同类事故随时复发）、**P1 加固**、**P2 可观测**。

> 不动 `orders.client_id UNIQUE` 约束本身 —— 约束是正确的，错的是写入方式。

### P0-1　记账永不阻断状态推进（核心）

`src/strategy/runner.js:77-103` 的 `recordOrder()` 改为幂等写入，把"撞唯一键"降级为正常分支：

```js
function recordOrder(userId, robotId, symbol, o) {
  const id = randomId('o');
  const clientId = o.clientId || id;
  const r = run(
    `INSERT INTO orders (...)
     VALUES (...)
     ON CONFLICT(client_id) DO NOTHING`,
    id, userId, robotId, clientId, /* ...其余字段 */);

  if (r.changes === 0) {
    // 已存在：说明这笔之前记过，直接复用旧行，不算错误
    return { id: null, clientId, existed: true };
  }
  return { id, clientId, existed: false };
}
```

要点：
- **不抛异常**，调用方无需 try；
- 调用方根据 `existed` 决定是否仍需 `addLeg`（见 P0-2）；
- 若需要原子性，`recordOrder` + 账本变更放进同一个 `tx()`。

### P0-2　账本推进与记账解耦，顺序统一为「先账本、后记账」

`src/strategy/runner.js:480-516` 开仓分支，改为与 paper 分支一致（paper 就是先动账本后记账）：

```js
// 1) 先推进账本（交易状态，必须有）
addLeg(legs, act.side, {
  qty, entryPrice, leverage, layer: act.layer,
  clientId: res.clientOrderId, reason: act.reason,
});

// 2) 再记账（审计用，失败只能是 warn，不能影响账本）
try {
  recordOrder(userId, robotId, symbol, { /* ... */ });
} catch (e) {
  logEvent(userId, robotId, 'warn', `订单记账失败：${e.message}（账本已推进）`);
}
```

平仓分支 `src/strategy/runner.js:546-565` 保持"先 drain、后 recordOrder"，但 `recordOrder` 同样不得抛出。

### P0-3　`clientOrderId` 改为真正唯一

`src/binance/live.js:291-298` 去掉时间桶，改为按「意图序号」生成：

```js
export function makeClientId(robotId, side, layer, action, seq) {
  const rb = String(robotId).replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'r';
  const sd = String(side || 'x').slice(0, 1).toLowerCase();
  const act = String(action || 'ord').replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'or';
  const lay = Math.max(0, Math.min(999, Number(layer) || 0));
  return `bt${rb}${sd}${lay}${act}${String(seq).padStart(6, '0')}`.slice(0, 36);
}
```

`seq` 来源二选一（推荐 A）：

- **A（推荐）**：`orders` 表的持久化自增 —— `SELECT COUNT(*) + 1 FROM orders WHERE robot_id = ?`，或独立 `seq` 表在事务内自增。与本机记录强绑定，重启不丢。
- **B（最简）**：`randomId()` 截 6–8 位随机串。实现最省事，但失去"同一意图可复现"的能力。

> 关键区别：以前是"**时间桶内**确定"，现在是"**每次意图**确定"。同一个意图重试仍复用同一 id，但只有真正同一笔意图才会复用。

### P0-4　补上「下单前查重」

`src/binance/live.js:401` `placeOrder()` 入口增加本地查重：

```js
if (spec.clientOrderId) {
  const local = get('SELECT * FROM orders WHERE client_id = ?', spec.clientOrderId);
  if (local && local.status === 'FILLED') {
    return { ...rowToOrder(local), _recovered: 'local' };  // 不再向币安发请求
  }
}
```

这是**唯一能挡住"交易所不认重复 id"的那道闸**。缺少它，任何重试路径都是真单。

### P0-5　实盘下单熔断

`src/strategy/runner.js` 的 tick 循环外层增加连续失败计数：

- 同一机器人连续 **N 次（建议 3）** 实盘下单相关错误 → 自动 `stopRobot()` + `saveRobot({ status: 'stopped', last_error })` + 一条 `error` 事件说明"已自动停止，避免重复下单"；
- 或退避：间隔 5s → 15s → 60s，而非恒定 5s。

现有架构下**第一种更安全**：实盘宁可停，不可盲重试。

### P0-6　账本为空但交易所非空时的硬拦截

在 `src/strategy/runner.js` 实盘开仓分支前加一道判断：

```js
const exQty = Number(((quote.positions || []).find((x) => x.side === act.side) || {}).qty) || 0;
if (ownQty(legs, act.side) === 0 && exQty > eps) {
  logEvent(userId, robotId, 'error',
    `账本为空但交易所${act.side === 'long' ? '多' : '空'}单有 ${exQty} 张，疑似状态不同步，`
    + '本 tick 拒绝开仓，请人工核对');
  continue;
}
```

**这条能直接掐断本次事故的死循环**——第 2 圈就会被拦住，而不是第 36 圈才被停止。

### P1-1　保护单改用 Algo Order API

`src/binance/live.js:487` `placeConditional()` 目前走 `POST /fapi/v1/order` 发 `STOP_MARKET` / `TAKE_PROFIT_MARKET`，币安已返回：

```
Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.
```

线上两个实盘机器人**交易所侧当前一张止损单都没有**，只靠 5 秒 tick 的软件止损。

改法：
1. 改用 Algo 端点（`/fapi/v1/algoOrder` 系列）；
2. `syncProtection()` 失败时把 `condWarn` 升级为**显式高危事件**（现在只静默存在 `state_json` 里），页面上要有醒目标识。

### P1-2　对账阈值收紧

`src/strategy/runner.js:247` 的 `rec.clamped[side] > 1e-12` 过松，制造大量 1e-5 量级的"手动平仓"误报，并且会真的 `drainQty` 缩减账本。改为与精度挂钩：

```js
const eps = Math.max(Number(rules.stepSize) / 2, 1e-8);
if (rec.clamped[side] > eps) { /* ... */ }
```

### P2-1　下单意图先落库（可选，实盘价值高）

流程改为三段式：`status=NEW` 插入 → 发单 → 回写 `FILLED` / `FAILED`。这样进程被 kill 也能靠 `clientOrderId` 查到"这笔到底发没发出去"，`placeOrder` 的超时分支也不至于只能返回 `null`。

### P2-2　事件降噪

同一错误连续出现时按"首次 + 每 N 分钟汇总一次"记录，避免 36 条同文案刷屏掩盖真实信号。

---

## 九、当前这笔账的处置（数据层，不是代码）

- 机器人 `r_1673cc03…` 已 `stopped`；交易所仍有 **0.7 张 SKHYNIXUSDT 多单**，均价 1145.11，50x cross，占用保证金；
- 本地账本里这笔是**零记录**（36 次 INSERT 全失败），因此**数据库里没有脏订单需要清理**；
- 建议：人工决定平掉还是保留。若保留并希望恢复托管流程 —— 先手动平掉 → 再在页面对该机器人做"**重置**"，让它以空账本重新开始。不要指望它自己认领：`reconcile()` 会按设计把它永久当作手动仓。

---

## 十、验收标准

改完后必须逐条通过：

1. 构造同一 5 分钟桶内"开 → 平 → 再开"：`orders.client_id` **不再出现重复值**；
2. 人为让 `recordOrder` 抛错（临时 mock）：账本仍会 `addLeg`，层数正常推进，**不再死循环**；
3. 人为重复同一个 `clientOrderId` 发单：第 2 次**不向币安发请求**（日志/抓包确认），直接复用本地成交记录；
4. 实盘连续 3 次下单异常：机器人**自动停止**，不再第 4 次发单；
5. 同一桶内重复平仓：不撞 `UNIQUE`。

---

## 十一、实施优先级

| 顺序 | 条目 | 说明 |
|---|---|---|
| 1 | P0-1 / P0-2 / P0-3 / P0-4 | **同一套病，缺一条都能复发**，必须一起上 |
| 2 | P0-5 / P0-6 | 护栏，防止未知异常再次演变成重复下单 |
| 3 | P1-1 | 止损单，独立且严重的风险，不要拖 |
| 4 | P1-2 / P2-1 / P2-2 | 噪声与可观测性，可随后迭代 |

---

## 附录 A：关键文件与行号索引

| 文件 | 行号 | 内容 |
|---|---|---|
| `src/binance/live.js` | 291-298 | `makeClientId()` 确定性 id 生成（问题源头） |
| `src/binance/live.js` | 401-474 | `placeOrder()`，含 `isDuplicateError → recoverByClientId` 分支 |
| `src/binance/live.js` | 487-535 | `placeConditional()`，`STOP_MARKET` / `TAKE_PROFIT_MARKET` |
| `src/binance/rest.js` | 1-120 | `BinanceError`、时间校准与 `binanceTimestamp()`；文件头注释承诺的"下单前查重"未实现 |
| `src/binance/rest.js` | 371-372 | `newOrder()` → `POST /fapi/v1/order` |
| `src/strategy/runner.js` | 77-103 | `recordOrder()`：`INSERT INTO orders`，唯一键冲突即抛 |
| `src/strategy/runner.js` | 480-516 | 实盘开仓：`makeClientId` → `recordOrder` → `addLeg`（顺序致命） |
| `src/strategy/runner.js` | 517-573 | 实盘平仓：`makeClientId(..., 0, 'cl')` → `drainLegs` → `recordOrder`（顺序相反） |
| `src/strategy/runner.js` | 575-577 | `catch` 只记日志、吞异常、不熔断 |
| `src/strategy/runner.js` | 228-270 | `reconcile()` 调用与手动仓告警节流 |
| `src/strategy/liveBook.js` | 全文 | `reconcile()` / `addLeg()` / `drainQty()` / `drainLegs()` / `baseline` 机制 |

## 附录 B：相关 SQLite 结构

```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  robot_id TEXT NOT NULL,
  client_id TEXT UNIQUE,        -- ← 崩溃点
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL,
  avg_price REAL,
  status TEXT NOT NULL,
  reduce_only INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  exchange_order_id TEXT,
  fee REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  realized_pnl REAL DEFAULT 0
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  robot_id TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  ts INTEGER NOT NULL          -- 注意：是 ts，不是 created_at
);
```

---

*本文档基于服务器 `/var/www/biance_trae` 与本地工作区的只读取证编写；取证期间未修改任何源码、未重启服务、未向币安发送任何请求。*
