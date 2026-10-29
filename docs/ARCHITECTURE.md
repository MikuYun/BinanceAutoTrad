**中文** ｜ [English](en/ARCHITECTURE.md) ｜ [日本語](ja/ARCHITECTURE.md)

# 代码架构与阅读指引

> 面向想读懂这份代码、或者想动手改它的人。本文结论全部来自仓库里的实际代码。

---

## 一、项目定位与技术选型

### 一句话定位

一个**零第三方依赖、单进程、纯 Node 内置模块**实现的币安 U 本位永续合约自动化交易平台：
后端是极简 HTTP 服务 + SQLite，前端是原生 JS 单页应用，
策略层按「定点加仓 + 均价止盈」驱动模拟盘或实盘下单。

### 为什么是这套技术栈

| 选型 | 实际情况 | 为什么这么做 |
|---|---|---|
| 零第三方依赖 | `package.json` 无 `dependencies` / `devDependencies` | 交易机器人要长期无人值守跑在陌生机器上。依赖树越大，供应链风险越高。零依赖让「克隆 → `node server.js`」成为唯一部署路径 |
| 数据库 `node:sqlite` | `src/db.js` 直接 `import { DatabaseSync } from 'node:sqlite'` | 单进程单用户不需要数据库服务端。文件型 SQLite 自带事务与 WAL，备份就是拷一个文件；内置模块**不需要编译原生扩展**，Windows 上不用装构建工具 |
| 不用 Python / FastAPI | 前后端同语言 | 策略层是大量数值计算，JS 的 IEEE-754 双精度够用；更关键的是**前后端共用一份参数 schema**（`PARAM_SCHEMA` 同时驱动后端校验和前端表单），省掉一套重复定义 |
| 不用 React / Vue | `src/static/app.js` 是 1655 行原生 ESM | 页面只有 6 个视图，不需要虚拟 DOM 与构建链。改完刷新即生效，没有 `npm run build` 这一层 |
| 不引入 Web 框架 | `src/http.js` 是 324 行手写 Router | 全部接口 28 个，路径都是静态段 + 一个 `:id`。手写 Router 比读透一个框架的中间件执行顺序还省事 |

**版本要求**：`package.json` 的 `engines.node` 是 `>=22.5.0`，因为 `node:sqlite` 从 Node 22.5 才提供，低于此版本启动直接抛错。实际推荐 Node 24 LTS。

---

## 二、整体架构图

```
┌ 浏览器 SPA  src/static/  index.html + app.js + styles.css
│   hash 路由 #/dashboard #/robots #/account #/apikeys · 纯 SVG 图表 · 3 秒轮询
└──────────────┬───────────────────────────────────────────────────
               │ HTTP (JSON)
┌──────────────▼───────────────────────────────────────────────────
│ HTTP 层  src/http.js
│ Router / 中间件 / body 解析 / Cookie / 静态托管 / BASE_PATH 剥离
│ 统一信封 { ok, data } | { ok:false, error:{ code, message } }
└──────────────┬───────────────────────────────────────────────────
               │ ctx = { req, res, params, query, body, user, cookies }
┌──────────────▼───────────────────────────────────────────────────
│ 认证 src/auth.js（第一个中间件，注入 ctx.user）
│ 路由 src/routers/  auth · robots · market · account · apikeys
└───────┬──────────────────────────┬────────────────────────────────
        │ 预览/校验/启停            │ 账户与行情查询
┌───────▼──────────────────┐  ┌────▼───────────────────────────────
│ 策略层 src/strategy/     │  │ 行情 src/binance/
│  params     参数 schema   │  │  index.js → getMarketFeed()
│  solver     数学(纯函数)  │  │    ├ liveMarket  真实行情
│  engine     决策状态机    │  │    └ mockMarket  本地模拟
│  runner     编排+持久化   │  │  protection.js 挂单识别
│  wallet     模拟盘共享钱包 │  └────────────────────────────────────
│  liveBook   实盘持仓账本  │
│  protect    条件单意图    │
│  accountStats 账户快照    │
└───────┬──────────────────┘
        │ getExchange(mode) → paper | live  （同一接口）
┌───────▼──────────────────────────────────────────────────────────
│ 交易所适配层 src/binance/
│  paper.js 本地撮合（0.05% 手续费 + 0.02% 滑点）
│  live.js  真实下单（精度规整 / 幂等 id / 条件单）
│  rest.js  签名客户端（硬超时 / 对时 / 有限重试）
└───────┬──────────────────────────────────────────────────────────
        │ /fapi/v1/*  /fapi/v2/*
   ┌────▼─────┐        持久化 data/app.db（WAL）
   │ 币安 REST │        密钥   data/master.key（0600）
   └──────────┘
```

---

## 三、目录结构逐项说明

### 根目录

| 文件 | 职责 |
|---|---|
| `server.js` | 入口装配：中间件与路由、启动行情与对时、恢复上次运行的机器人、优雅退出 |
| `package.json` | 只有 `start` / `check` / `test` 三个脚本，无任何依赖 |
| `README.md` | 面向使用者：是什么、怎么跑、参数怎么调、风险提示 |
| `DEPLOY.md` | 面向运维：systemd、Nginx 反代、HTTPS、备份、升级回滚 |
| `LICENSE` | Apache License 2.0 |
| `data/` | 运行时自动创建，**不进 git**：`app.db`、`master.key`、`rules-cache.json` |

### 后端核心

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/config.js` | 108 | 全局配置：`PORT` / `HOST` / `BASE_PATH` / `LIVE_TRADING` / `BT_MASTER_KEY` / `BINANCE` / `PAPER`，以及 `MASTER_KEY` 的加载与自动生成 |
| `src/db.js` | 191 | SQLite 访问层：建表、索引、老库 `ALTER` 升级，导出 `all` / `get` / `run` / `tx` |
| `src/http.js` | 324 | 极简 HTTP 框架：`Router`、`HttpError`、body 解析、Cookie、静态托管、前缀剥离、统一错误响应 |
| `src/crypto.js` | 124 | AES-256-GCM 加解密、`maskKey`、scrypt 口令哈希与 `timingSafeEqual` 校验、`randomId`、HMAC-SHA256、SHA-256 |
| `src/auth.js` | 178 | 账号与会话：注册、登录、`bt_sid` Cookie、登录失败限流、`authMiddleware` |

### 路由层 `src/routers/`（5 个模块，共 28 个端点）

| 文件 | 端点 | 职责 |
|---|---|---|
| `auth.js` | 5 | 注册 / 登录 / 登出、`GET /api/me`、`GET /api/meta/defaults`（参数 schema 与标的列表） |
| `robots.js` | 11 | 机器人 CRUD、`preview` 预演、start / stop / reset、事件与订单流水 |
| `market.js` | 4 | 标的列表、K 线、行情概览、连通性健康检查 |
| `account.js` | 4 | 账户概览（paper / live）、账户级权益曲线、模拟盘钱包读写 |
| `apikeys.js` | 4 | API Key 增删查，以及调币安接口做一次「验证」 |

### 交易所适配层 `src/binance/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `rest.js` | 423 | 币安 REST 客户端：签名、`recvWindow`、时间偏移校准、硬超时、只对幂等请求重试 |
| `live.js` | 605 | 实盘：精度规整、确定性 `clientOrderId`、下单/条件单/撤单、账户读取、规则三级缓存 |
| `paper.js` | 266 | 模拟盘撮合：开仓、整边平仓、逐笔平仓、权益与快照 |
| `liveMarket.js` | 356 | 实盘行情：后台定时刷价格与 24h ticker，同步接口只读内存缓存 |
| `mockMarket.js` | 248 | 离线行情：几何布朗运动 + 均值回复，确定性可复现 |
| `index.js` | 71 | 统一入口：`getMarketFeed()`、`startMarket()`、`getExchange(mode)`、`loadCredentials(userId)` |
| `protection.js` | 153 | 从币安真实挂单识别止盈止损，把止损夹在入场价与强平价之间 |

### 策略层 `src/strategy/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `params.js` | 371 | 参数 schema、默认值、旧参数名归一化、参数校验（含最小下单额判断） |
| `solver.js` | 524 | 纯数学求解：最小可下单额、强平价、止盈止损目标、加仓阶梯、可行性判定 |
| `engine.js` | 276 | 决策状态机：把「持仓 + 行情 + 计划」翻译成一组 `action` |
| `runner.js` | 1210 | 编排器：每个机器人一个定时器，串起行情→账本→决策→执行→落库 |
| `wallet.js` | 243 | 模拟盘账户级共享钱包：现金记 `paper_accounts`，持仓记 `robots.paper_json` |
| `liveBook.js` | 280 | 实盘持仓账本 `liveLegs` + 接管状态：交易所是唯一真相源，多出来的仓位全部接管 |
| `protect.js` | 198 | 保护单意图：算出「应该挂哪些止盈止损」，与已挂单做差量 |
| `accountStats.js` | 250 | 账户级权益快照、日基准、账户曲线与今日盈亏 |

### 前端与脚本

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/static/index.html` | 46 | 单页外壳：导航、首屏主题恢复、挂载点 |
| `src/static/app.js` | 1655 | 全部前端逻辑：hash 路由、轮询、局部刷新、schema 表单、纯 SVG 图表 |
| `src/static/styles.css` | 320 | 四套主题（dark / light / blue / warm）的 CSS 变量与布局 |
| `scripts/check.js` | 52 | 零依赖自检：全量 `node --check` + 关键文件存在性 |
| `scripts/test-*.mjs` | 839 | 6 组单元测试，64 个用例 |

合计约 **1.05 万行**。

---

## 四、请求生命周期

以 `POST /api/robots/:id/start` 为例：

| # | 环节 | 说明 |
|---|---|---|
| ① | `http.createServer` | `src/http.js` 收到请求，`new URL(req.url, 'http://localhost')` 取 pathname 与 query |
| ② | BASE_PATH 剥离 | 部署在 `/biance_trae` 时，`/biance_trae/api/...` 先剥成 `/api/...`，Cookie Path 也带前缀 |
| ③ | 构造 ctx | `{ req, res, params:{}, query, body:{}, user:null, cookies:parseCookies(...) }` |
| ④ | 中间件 | 唯一一个：`authMiddleware(ctx)` → 从 `bt_sid` 反查会话，注入 `ctx.user` |
| ⑤ | 路由匹配 | `matchRoute('POST', pathname)`：段数必须相等，`:id` 段 `decodeURIComponent` 后填入 `params` |
| ⑥ | body 解析 | 只有 POST / PATCH / DELETE 读 body；超 1MB 抛 `413 BODY_TOO_LARGE`，非 JSON 抛 `400 BAD_BODY` |
| ⑦ | 处理器 | `routes/robots.js`：`requireAuth` → `ownedRobot(userId, id)`（`WHERE id=? AND user_id=?`，查不到 404，同时防越权）|
| ⑧ | 业务闸门 | live 且 `!TRADING.liveEnabled` → `400 LIVE_DISABLED`；live 且无 verified Key → `400 NO_API_KEY` |
| ⑨ | 副作用 | `UPDATE robots SET status='running'` + `logEvent('机器人启动')` + `runner.startRobot(fresh)` |
| ⑩ | 返回 | handler 返回非 `undefined` 且未发头 → 自动 `ok(ctx, 结果)`；写 `Content-Type` / `Content-Length` / `Cache-Control: no-store` |
| ⑪ | 异常 | `HttpError` → `fail(status, code, message)`；其它 → `500 INTERNAL_ERROR`，绝不把内部细节回传前端 |

两个要点：`authMiddleware` 必须是**第一个**注册的中间件；业务错误全部 `throw new HttpError(status, CODE, '中文提示')`，前端只看 `error.code` 分支、直接把 `error.message` 弹 toast。

---

## 五、机器人 tick 生命周期

`startRobot()` 会 `setInterval(TICK.intervalMs)`（默认 **5000ms**，可用 `TICK_INTERVAL_MS` 调整），并**立刻**先跑一次 tick，不等第一个间隔。

| # | 步骤 | 关键行为 |
|---|---|---|
| 1 | 取行情 | `feed.getPrice(symbol)` + `feed.atrPctAsync(symbol, params.interval\|\|'1h')`；异常写 `warn` 事件并 `return` |
| 2 | 校验价格 | `price > 0` 否则写「当前价格无效，跳过本次决策」 |
| 3 | 拉 K 线 | `klinesAsync(symbol, interval, 60)`，失败降级为空数组 |
| 4 | 确认仍在运行 | 重查 `SELECT * FROM robots WHERE id=?`，`status !== 'running'` 就 `stopRobot` 收摊 |
| 5 | 取规则 | `getExchange(mode)`；live 用 `getLiveRules(symbol)`（10 分钟缓存），paper 用 `PAPER_RULES` |
| 6 | 算钱 | paper：`getWallet` + `mergeBook(paper_json, wallet)` 拼 book，`equityOf(book, price)`；live：`loadCredentials` → `fetchAccount` 读真实权益，且**必须** `filterBySymbol(quote.positions, symbol)` |
| 7 | 实盘对账 | `parseLiveLegs` + `parseTakeover` + `reconcile(legs, quote.positions, takeover, rules)`：交易所多出来的仓位**全部接管**进账本（`info`，节流），少了就按比例缩减账本（`warn`）；容差 = `max(1e-8, stepSize/2)` |
| 8 | 权益闸 | `equity <= 0` → 写「权益为 0，无法计算仓位」并返回 |
| 9 | 定锚点 | 有持仓 → 沿用 `state.anchorPrice`；空仓 → 用当前价（持仓期间触发价不漂移） |
| 10 | 求解计划 | `decide({...})` 内部调 `solvePlan`，再按持仓状态产出 `actions` / `notes` |
| 11 | 记依据 | `result.notes` 逐条写成 `info` 事件，前端详情页直接可见 |
| 12 | 无动作分支 | live 也要把对账后账本写回 `state_json`（否则手动平仓后账本不收敛）；`recordAccountEquity` → `saveRobot({last_tick})` → `recordEquity`；每 60 秒 `syncProtection` 复核交易所止盈止损还在 |
| 13 | 执行动作 | 逐条处理 `actions`，每条开头查 `entry.stopped`（用户点停止时立刻收手） |
| 14 | 模拟盘下单 | 先 `availableForUser(userId)` 校验可用余额，再 `exchange.openPosition(...)`，失败写 `warn` |
| 15 | 实盘下单 | **先过安全闸**：`if (!TRADING.liveEnabled)` 写「本次只读取行情与账户，不会向币安发送任何订单」后 `continue`；过了才 `placeOrder` + `addLeg` 记账 |
| 16 | 平仓记账 | paper 走 `closeLegs`（逐笔止盈）/ `closeSide`；live 只平账本里的 `ownQty`，用被平部分加权均价算 `realizedPnl` |
| 17 | 落库 | `recordOrder` 写 `orders`；`applyWalletDelta` + `splitBook` 写回钱包与 `paper_json`；`saveRobot` 更新 `state_json` |
| 18 | 写事件 | `logEvent` 写 `events`，前端事件流直接消费 |

重入保护：`entry.ticking` 为真时跳过本轮——行情接口慢于 5 秒也不会叠出两条并发决策。

---

## 六、策略层四个文件的分工

分工的界限是「**谁能碰 IO**」：

| 文件 | 允许 IO | 输入 | 输出 | 一句话 |
|---|---|---|---|---|
| `params.js` | 否 | 前端原始 JSON | 归一化后的完整参数 + 校验结果 | 定义「用户能填什么」 |
| `solver.js` | **否，纯函数** | `{equity, price, params, rules, anchorPrice, realizedPnl}` | 完整计划（层数、每层名义与触发价、均价、强平价、止盈止损价、是否可行） | 算「数学上该怎么下单」 |
| `engine.js` | 否 | `{params, book, markPrice, equity, rules, quote, anchorPrice, realizedPnl}` | `{ actions, plan, halted, notes }` | 判「此刻该开首笔 / 加仓 / 止盈 / 止损 / 不动」 |
| `runner.js` | **是，唯一 IO 出口** | 一个机器人 id | 副作用：下单、写库、写事件 | 每 5 秒串一遍上面三层 |

**`params.js`**：`PARAM_SCHEMA` 是 13 项数组，每项 `{ key, label, group, type, default, options?, min, max, step, help }`，同时是前端表单（`renderSchemaForm`）与后端校验的定义源，加参数只改这一处。`normalizeParams(raw)` 先把旧参数名映射成新名（`k`→`firstPct`、`beta`→`spacingPct`、`kMax`→`totalPct`、`dMax`→`maxLossPct`、`stopAtr`→`stopPct`、`initialCapital`→`allocatedCapital`），再按 schema clamp / 白名单过滤，保证输出字段齐全。`validateParams(params, {minNotional, minQty, stepSize, price})` 返回 `{ok, errors, warnings, params}`：硬错误是「第一笔名义低于真正的最小可下金额」这类算不出结果的组合，warning 是「止损空间比加仓间距还小」这类能跑但不好的组合。

**`solver.js`**：无 `fetch`、无数据库、无业务相关的 `Date.now()`，所以能被单测直接调。核心函数：

| 函数 | 作用 |
|---|---|
| `requiredQtyUnits` / `qtyUnitsOf` | 把「名义金额」折算成「多少个最小数量台阶」 |
| `minOrderNotional(price, rules)` | **真正**的最小可下名义 = `max(交易所 minNotional, 最小数量 × stepSize × 价格)` |
| `canPlaceNotional(notional, price, rules)` | 上面那条线的布尔版 |
| `liqPrice(qty, avgEntry, equity, side)` | 全仓近似强平价，`equity` 必须是账户真实权益 |
| `tpTargetFor` / `stopTargetFor` / `safeStop` | 止盈按**当前实际均价**算，止损按 `stopPct` 算后夹进入场价与强平价之间 |
| `solvePlan(input)` | 主入口：层数从 `maxLayers` 往下试，直到同时满足名义上限、亏损预算、止损先于强平 |
| `solveLayers(plan)` | 取 `plan.layerList` 给前端画阶梯表 |

**`engine.js`**：状态机 `IDLE ──建首层──▶ HOLDING ──踩到间距──▶ 加仓 ──▶ FULL ──止盈/止损──▶ IDLE`。`decide()` 分支顺序固定且有意图：先算 `sideState`，再 `solvePlan`，不可行就只返回 `notes`；然后逐边 **空仓开首笔 ＞ 止损 ＞ 止盈 ＞ 加仓**（先保命，再落袋，最后才加仓）。每次开仓前过两道闸：`canPlaceNotional` 与 `ownUsedMargin + 新占用 <= capitalBudget`。

**`runner.js`**：`running` 是 `Map<robotId, entry>`，`startRobot` / `stopRobot` / `bootAll` / `shutdownAll` 管理它；把 `actions` 翻译成真实的 `placeOrder` / `openPosition` / `closeSide`；`saveRobot` / `recordOrder` / `recordEquity` / `logEvent` 四个写库函数全部 `try/catch`——写日志失败绝不能让交易停下来。

---

## 七、交易所适配层的双实现

`src/binance/index.js` 只有一行选择：`mode === 'live' ? liveExchange : paperExchange`，两个对象都带 `type` 字段。`runner.js` 只用能力子集：

| 调用点 | paper 实现 | live 实现 |
|---|---|---|
| 读取权益 | `equityOf(book, markPrice)` 本地算 | `fetchAccount(creds)` 读交易所 |
| 开仓 | `openPosition(book, {...})` 本地加一笔 leg | `placeOrder(...)` 真发市价单再 `addLeg` |
| 平仓 | `closeSide` / `closeLegs` 本地扣减 | `placeOrder(reduceOnly)`，用被平部分加权均价算盈亏 |
| 取精度规则 | 常量 `PAPER_RULES` | `getRules(symbol)` 走 `exchangeInfo`，失败退回磁盘缓存 |

`closeLegs` 不是两边都有：`runner.js` 用 `typeof exchange.closeLegs === 'function'` 探测后才走逐笔止盈，否则退回整边平仓。这是刻意的**能力探测**而非接口强约束。

行情侧 `liveMarket` 与 `mockMarket` 导出**同名同形**的对象，`index.js` 按 `process.env.BINANCE_FEED === 'mock'` 二选一：

| 能力 | `liveMarket` | `mockMarket` |
|---|---|---|
| 同步接口 | 只读内存缓存（`quotes` Map），永不阻塞事件循环 | 本地即时计算，必然可用 |
| 异步接口 | `atrPctAsync` / `klinesAsync` 直接联网 | 随机游走生成 OHLCV 再算 ATR |
| 刷新 | 后台定时器：价格 3s、ticker 30s、标的列表 5min | `tickMarket()` 由 `server.js` 每 3s 推一次 |
| 失败行为 | 降级到 mock 价格并标 `degraded: true` | 不存在失败 |

---

## 八、数据流与持久化

`app.db` 共 **10 张表**：7 张核心业务表 + 3 张支撑表。

| 表 | 主键 | 职责 | 谁写 |
|---|---|---|---|
| `users` | `id` | 账号：用户名、scrypt 口令哈希、创建时间 | `auth.js` |
| `api_keys` | `id` | 加密后的 Key / Secret、打码值、验证状态与最近错误 | `routers/apikeys.js` |
| `robots` | `id` | 交易对、模式、状态、`params_json`、`state_json`、`paper_json` | `routers/robots.js`、`runner.js` |
| `paper_accounts` | `user_id` | 模拟盘账户级共享钱包：余额、初始余额、已实现盈亏、累计手续费 | `wallet.js` |
| `orders` | `id`（`client_id` 唯一） | 订单流水：成交均价、手续费、`realized_pnl`、`reduce_only` | `recordOrder` |
| `equity_curve` | 自增 | **单机器人**权益曲线点：时间、权益、价格、持仓量 | `recordEquity` |
| `events` | 自增 | 机器人事件流（`info`/`warn`/`error`/`trade`），前端详情页直接读 | `logEvent` |
| `sessions` | `id` | 登录会话：token、用户、过期时间、UA；`purgeExpiredSessions()` 清理 | `auth.js` |
| `account_equity` | 自增 | **账户级**权益快照，15 秒节流写入，只保留最近 5000 条 | `accountStats.js` |
| `account_daily` | `(user_id, mode, day)` | 每日开盘基准，今日盈亏 = 当前权益 − 当日基准 | `accountStats.js` |

为什么要分成「机器人级 `equity_curve`」和「账户级 `account_equity`」两张表？模拟盘的钱是**全账户共享钱包**，单机器人曲线只代表那台机器人：直接拿它当概览曲线，用户改一次钱包余额曲线就会垂直跳水，两台本金量级差很多的机器人也会把同一个坐标系撑得看不清。

### `paper_accounts` 与 `robots.paper_json` 的关系

这是最容易读错的地方：**现金和持仓分两家存**。

```
paper_accounts（每用户一行，账户级）
  balance / initial_balance / realized_pnl / fee_paid
robots.paper_json（每机器人一份，机器人级）
  positions.long[] / positions.short[] / realizedPnl / feePaid / lastPrice
```

每个 tick 用 `mergeBook(robotBook, wallet)` 拼成完整 book 交给 `paper.js`，算完用 `splitBook(book)` 拆回去分别落库。这样做是为了贴近币安全仓账户的真实行为：多个模拟机器人共用一份可用余额，谁先占用保证金谁先占，不够就开不出仓。若每个机器人各存一份余额，「我有 100U，开两个机器人各分 100U」就会凭空变成 200U。

### 实盘的持久化在哪

实盘没有「现金」概念，权益永远从交易所读。`robots.state_json` 里存：`liveLegs`（机器人持仓账本，接管模式下已含交易所原有仓位）、`takeover`（接管状态：`{long:{qty,entryPrice,at}|null, short:...}`，该方向仓归零后自动清空）、`takeoverNotice`（接管提示节流）、`condOrders`（已挂保护单快照，用于差量同步）、`anchorPrice`、`realizedPnl`（下次 tick 才并入资金基数）、`equity` / `balance` / `positions`（最近一次读到的交易所状态，给前端渲染）。

---

## 九、关键设计决策（以及为什么）

**1. 确定性 `clientOrderId` 实现幂等**
`makeClientId(robotId, side, layer, action, bucketMs = 300000)` 用机器人 id + 方向 + 层号 + 动作 + 5 分钟时间桶拼出来，不做随机。理由是网络超时这个真实场景：请求发出去了、响应没回来，到底成没成交不知道。随机 id 会在下一 tick 重发时**真的再开一仓**；确定性 id 重发会被币安按重复 `clientOrderId` 拒掉（`-4015` / `-4116`），再按 id 回查（`recoverByClientId`）就知道第一笔已成交。同理 `rest.js` **只对 `GET` 与撤单 `DELETE` 重试，下单 `POST` 绝不自动重试**——超时不等于没成交。

**2. 实盘独立持仓账本 `liveLegs`**
币安 U 本位双向持仓下，同一 symbol 的多头是**账户级聚合**的：`positionRisk` 只告诉你「这个币有多单 4.37 张」，分不清哪几笔是机器人开的。早期方案是「只认自己账本、多出来的当手动仓不碰」，结果会出现「账户大仓、机器人小仓」以及手动平仓后机器人账本静默归零再重复建仓的事故。**1.0.2 起改成接管模式**：每台实盘机器人在 `state_json.liveLegs` 记账本，开仓成功 `addLeg`，平仓按数量 `drainQty` / `drainLegs`，每 tick `reconcile` 对账——交易所**多**出来的仓位全部接管进账本（入场价用增量反解，保证账本加权均价 = 交易所真实均价），**少**了就按比例缩减。接管方向不加仓，按真实均价算出的止盈价到了一次性整边全平，平完才重建第一层。账本只用来算层数、均价、可平数量；**权益永远取交易所真实值**。

**3. 时间戳偏移校准**
签名请求的 `timestamp` 必须落在 `recvWindow` 内，否则报 `-1021`。经反向代理时单程可能几百毫秒到数秒，本地时钟也可能偏。`rest.js` 的 `syncTime()` 请求 `/fapi/v1/time`，用**往返中点**估出 `timeOffsetMs`，之后一律 `Date.now() + offset`；`startTimeSync()` 每 60 秒（`BINANCE_TIME_SYNC_MS`，夹 10s~600s）重新校准；遇 `-1021` / `-1022` 还会强制重同步后重试一次。`recvWindow` 默认 5000ms，`BINANCE_RECV_WINDOW` 可在 1000~60000 调整。

**4. 精度规则缓存 `rules-cache.json`**
交易所对数量与价格都有步长要求，多一位小数就是 `-1111`。但 `exchangeInfo` 响应约 1.1MB、上千个合约，不能每单都拉。`live.js` 做三层：内存 `Map`（TTL 10 分钟）→ 落盘 `data/rules-cache.json`（0600）→ 兜底 `HARDCODED_RULES` 并标 `degraded: true`。**降级规则不会被缓存**，避免一次网络抖动把错误精度固化。下单时还有一层：`precisionAttempts()` 把数量与触发价同步逐档降精度（最多 4 档），每档都要满足最小名义，遇 `-1111` 换下一档重发。`parseFilters()` 会取 `LOT_SIZE` 与 `MARKET_LOT_SIZE` 中**更粗**的步长，因为市价单按 `MARKET_LOT_SIZE` 校验。

**5. `LIVE_TRADING` 安全闸**
`config.js` 只有一行 `export const TRADING = { liveEnabled: process.env.LIVE_TRADING === '1' }`，但被三处检查形成纵深防御：`routers/robots.js` 的 start 拒绝启动（`400 LIVE_DISABLED`）；`runner.js` 下单前拦每一笔实盘订单并写 `warn`；实盘 tick 照常读行情与账户，所以页面数据是活的。默认**关**，想开必须显式在启动命令里加 `LIVE_TRADING=1`，重启即回到关闭。

**6. 价格锚点 `anchorPrice`**
`anchorPrice` 在**空仓时**取当时成交价，持仓期间一直沿用，直到完全平仓才重新取锚。不固定锚点的话，触发价会随实时价滑动：价格往下走加仓线也跟着走，**永远等不到加仓**；往上走止盈目标也一起漂，止盈永远打不到。固定后第 N 层的触发价在开仓那一刻就确定，行为可复现、可单测（`test-capital.mjs` 里就有一条「同一 anchorPrice 产出的阶梯完全一致」）。

---

## 十、测试与自检

**`node scripts/check.js`**（52 行，零依赖）做两件事：递归 `walk(ROOT)` 收集所有 `.js`（跳过 `node_modules`、`data`、`.git`），逐个 `spawnSync(process.execPath, ['--check', file])` 只查语法不执行；再检查关键文件存在性（`server.js`、`package.json`、`src/static/index.html`、`src/static/app.js`、`src/static/styles.css`）。输出 `检查 JS 文件 N 个，语法错误 M 个。`，任一失败 `process.exitCode = 1`，全过打印 `✅ 全部通过`。

**6 组单元测试**全部用 `node:test` + `node:assert/strict`，无测试框架依赖，共 **64 个用例**：

| 文件 | 用例 | 测什么 |
|---|---|---|
| `test-capital.mjs` | 10 | 仓位按 `allocatedCapital` 算而非账户权益；资金太小判不可行；加仓累计占用不超预算；跌到间距才加仓且均价被摊低；锚点固定时阶梯一致；资金基数 = 分配资金 + 已实现盈亏；亏光后归零不变负；收益并入基数后阶梯同步放大；`decide` 透传 `realizedPnl` |
| `test-minqty.mjs` | 8 | 「名义够但数量摊不到一个最小台阶」的边界：`requiredQtyUnits` / `qtyUnitsOf` / `minOrderNotional` / `canPlaceNotional`；粗步长标的上判不可行并给中文提示；正好一个台阶时可行；BTC 仍按名义门槛主导；`decide` 资金不足不下单 |
| `test-precision.mjs` | 12 | 精度规则：股票类永续（`TRADIFI_PERPETUAL`）必须被当作可交易；交割与停止交易的排除；`parseFilters` 解析真实过滤器；`MARKET_LOT_SIZE` 更粗时取粗、没有就退回 `LOT_SIZE`；降精度候选只在名义仍够时给出；条件单数量与触发价同步降精度；`fmtPrice` 按 `tickSize` 四舍五入；`stepSize=1` 取整；科学计数法步长 |
| `test-protect.mjs` | 11 | 保护单意图：`avg` 模式整边一对、`layer` 模式每笔一个止盈且止损只有一个、接管模式下强制整边一张、空单方向相反、止损夹在入场与强平之间、名义不足进 `skipped`、无持仓不产单、`diffCondOrders` 同 id 不重发 / 触发价变了撤旧挂新 / 交易所已消失的清理、`normalizeCondOrders` 兼容两种历史结构 |
| `test-protection.mjs` | 6 | 从币安**真实挂单**识别止盈止损的方向语义；无挂单时 `source='none'` 且价格返回 0（平台不应自己编价格）；`clampStopToLiq` 把翻到错误一侧的止损拉回来 |
| `test-livebook.mjs` | 13 | `liveLegs` 账本：累加与加权均价、脏数据不入账、三方对账（多出→全部接管 / 少→按比例缩减 / 全平→清零）、按数量扣减时均价不变、逐笔平仓只扣指定几笔、`bookOf` 结构、`parseLiveLegs` 容错、`filterBySymbol` 只留本交易对 |
| `test-takeover.mjs` | 9 | 接管模式：`takeoverSides` 判空、接管期间不加仓（带对照组）、`tpMode=layer` 也整边全平、止盈价按交易所真实均价、接管仓仍受硬止损、平完后重建第一层、对账增量反解均价、`stepSize/2` 对账容差 |

```bash
node scripts/check.js        # 语法自检
node --test scripts/*.mjs    # 全部单元测试
```

也可以 `npm run check` / `npm test`。

---

## 十一、二次开发指引

### 加一个新策略

**改法 A：只换算法，复用调度与持久化（推荐）**

| 要动的文件 | 怎么动 |
|---|---|
| `src/strategy/solver.js` | 加新求解函数，返回同样形状的计划对象（至少含 `feasible` / `layers` / `layerList` / `tpPrice` / `stopPrice`） |
| `src/strategy/engine.js` | 在 `decide()` 里按参数分派到不同求解函数，`actions` 结构保持不变 |
| `src/strategy/params.js` | 在 `PARAM_SCHEMA` 加参数（自动出现在前端表单），在 `normalizeParams` 补兜底 |
| `src/strategy/runner.js` | **通常不用改**——它只消费 `actions` 的约定字段 |

`actions` 的约定是 `{ type:'open'|'close', side:'long'|'short', layer, notional, price, reason, legIds? }`，只要产出的 `actions` 满足这个形状，执行、记账、落库、写事件全都不用动。

**改法 B：新增调度器**。若新策略的节奏根本不是「每 5 秒检查」（比如事件驱动），照 `runner.js` 的接口另写一个模块，实现 `startRobot` / `stopRobot` / `isRunning` / `bootAll` / `shutdownAll`，再在 `server.js` 与 `routers/robots.js` 按 `robot.strategy` 字段分派。`robots` 表加一列即可，`db.js` 里已有「检查列是否存在再 `ALTER TABLE`」的升级写法可照抄。

### 接别的交易所

只需动适配层，**策略层一行都不用改**：

| 步骤 | 文件 | 说明 |
|---|---|---|
| 1 | 新建 `src/binance/<exchange>.js` | 实现 exchange 对象：`type`、`fetchAccount`（live 侧）/ `equityOf`（paper 侧）、`openPosition` / `placeOrder`、`closeSide`、`getRules` |
| 2 | 新建 `src/binance/<exchange>Market.js` | 行情源，导出与 `liveMarket` / `mockMarket` 同名同形的对象：`getPrice` / `ticker` / `atrPct` / `klines` / `funding` / `symbols` / `ping` / `health`，异步版加 `*Async` |
| 3 | 改 `src/binance/index.js` | `getMarketFeed()` 与 `getExchange()` 加分支；`loadCredentials` 若字段不同要一起改 |
| 4 | 新建 `<exchange>Protection.js`（如需） | 照 `src/binance/protection.js` 的形状：`protectionFromOrders(orders, {symbol, side, markPrice})` |
| 5 | 加测试 | 在 `scripts/` 加 `test-<exchange>.mjs`，用假数据测精度规整与幂等 id，**不要**在单测里发真实请求 |

换交易所后大概率要重写的三处语义：**精度规则**（`parseFilters` / `precisionAttempts` 是币安 `exchangeInfo` 的形状）、**幂等机制**（依赖交易所支持客户端订单 id 去重）、**持仓模式**（`liveLegs` 的前提是「交易所以 symbol + 方向聚合持仓」，若新交易所本身能按订单区分持仓，这一层可以简化）。

### 加一个 HTTP 接口

1. 在对应的 `src/routers/*.js` 里加 `app.get/post/...`，路径**不带** `/api` 前缀（框架已按 `/api` 分流，实际写 `/robots/:id/xxx`）；
2. 业务错误统一 `throw new HttpError(4xx, 'CODE', '中文提示')`；
3. 返回普通对象即可，框架自动包成 `{ ok: true, data }`；
4. 涉及资源归属的一律先 `ownedRobot(userId, id)`，`WHERE id=? AND user_id=?` 同时完成查询与越权防护。

---

## 十二、进一步阅读

| 想知道什么 | 去哪看 |
|---|---|
| 怎么用、界面怎么点 | [README.md](../README.md) |
| 13 个参数各自的数学含义 | [STRATEGY.md](STRATEGY.md) |
| 部署到服务器、systemd、HTTPS | [DEPLOY.md](../DEPLOY.md) |
| 安全策略与漏洞报告 | [SECURITY.md](../SECURITY.md) |
| 怎么贡献代码 | [CONTRIBUTING.md](../CONTRIBUTING.md) |
