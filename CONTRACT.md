# 币安合约交易机器人平台 — 工程契约（所有队友必须遵守）

> 技术栈：**零第三方依赖**。Node 24 内置模块 only（`node:http` / `node:sqlite` / `node:crypto` / `node:fs` / `node:path`）。
> 语言：ESM（`package.json` 里 `"type":"module"`）。**不允许 `npm install` 任何包**。
> 代码风格：2 空格缩进、单引号、分号结尾、中文注释、中文 UI 文案。
> 所有时间戳为**毫秒整数**（`Date.now()`）。

---

## 0. 目录与写入范围（严禁越界）

| 负责人 | 可写路径 |
|---|---|
| lead | `server.js`、`package.json`、`README.md`、`src/config.js`、`src/db.js`、`src/crypto.js`、`src/http.js`、`src/auth.js`、`src/routers/auth.js`、`src/routers/robots.js` |
| backend-exchange | `src/binance/**`、`src/routers/market.js`、`src/routers/account.js`、`src/routers/apikeys.js` |
| strategy | `src/strategy/**` |
| frontend | `src/static/**` |

只读可 import：任何 `src/**`（但只能写自己范围内的文件）。

---

## 1. 基础模块接口（lead 提供，直接 import 使用）

### `src/config.js`
```js
export const ROOT;          // 项目根绝对路径
export const DATA_DIR;      // B:\biance_trae\data
export const MASTER_KEY;    // Buffer(32)
export const PORT;          // 默认 8787
export const BINANCE;       // { baseUrl, proxy, timeoutMs }
export const SESSION_TTL_SEC;
export const PAPER;         // { feeRate, slippagePct, tickIntervalMs }
```

### `src/db.js`
```js
export const db;                                  // DatabaseSync 实例
export function all(sql, ...params): object[]
export function get(sql, ...params): object|undefined
export function run(sql, ...params): {changes, lastInsertRowid}
export function tx(fn): any                       // 事务包裹
```

### `src/crypto.js`
```js
export function encrypt(plain: string): string    // 'v1.iv.tag.ct' (AES-256-GCM)
export function decrypt(blob: string): string
export function maskKey(k: string): string        // 'abcd****wxyz'
export function hashPassword(pw: string): string  // 'scrypt$salt$hash'
export function verifyPassword(pw, stored): boolean
export function randomId(prefix?: string): string
export function hmacSha256Hex(secret: string, payload: string): string
export function sha256Hex(s: string): string
```

### `src/http.js`
```js
export class HttpError extends Error { constructor(status, code, message) }
export const app;   // 路由表
// 注册路由（handler 可为 async）：
app.get(path, handler)
app.post(path, handler)
app.patch(path, handler)
app.del(path, handler)
// 路径参数写法 '/api/robots/:id'
// handler 收到的 ctx：
// { req, res, params, query, body, user, cookies }
//   - body 已被解析为对象（JSON 或 form）
//   - user 为已登录用户行 {id, username, created_at}，未登录为 null
//   - cookies 为对象
export function json(ctx, data, status = 200)
export function ok(ctx, data)          // -> {ok:true, data}
export function fail(ctx, status, code, message)   // -> {ok:false, error:{code,message}}
export function requireAuth(ctx)       // 未登录抛 HttpError(401,'UNAUTHORIZED')
export function setCookie(ctx, name, value, opts)
```

### `src/auth.js`
```js
export function register(username, password): user
export function login(username, password): { token, user }
export function userFromToken(token): user | null
export function destroySession(token): void
export function currentUser(ctx): user | null
```

---

## 2. 数据库表结构（已由 lead 建好，禁止改结构）

```sql
users(id TEXT PK, username TEXT UNIQUE, password_hash TEXT, created_at INT)
sessions(id TEXT PK, user_id TEXT, created_at INT, expires_at INT, ua TEXT)
api_keys(id TEXT PK, user_id TEXT, label TEXT, key_enc TEXT, secret_enc TEXT,
         masked TEXT, status TEXT, last_verified INT, last_error TEXT, created_at INT)
robots(id TEXT PK, user_id TEXT, name TEXT, symbol TEXT, mode TEXT, status TEXT,
       params_json TEXT, state_json TEXT, paper_json TEXT,
       created_at INT, updated_at INT, started_at INT, last_tick INT, last_error TEXT)
orders(id TEXT PK, user_id TEXT, robot_id TEXT, client_id TEXT UNIQUE, symbol TEXT,
       side TEXT, type TEXT, qty REAL, price REAL, avg_price REAL, status TEXT,
       reduce_only INT, reason TEXT, exchange_order_id TEXT, fee REAL,
       created_at INT, updated_at INT)
equity_curve(id INTEGER PK AUTOINCREMENT, robot_id TEXT, ts INT, equity REAL,
             price REAL, position_qty REAL)
events(id INTEGER PK AUTOINCREMENT, user_id TEXT, robot_id TEXT, level TEXT,
       message TEXT, ts INT)
```

`robots.status` ∈ `stopped | running | error`
`robots.mode` ∈ `paper | live`
`orders.status` ∈ `new | filled | canceled | rejected`
`events.level` ∈ `info | warn | error`

---

## 3. 交易所适配层（backend-exchange 提供）

### `src/binance/index.js`
```js
export function getMarketFeed(): MarketFeed
export function getExchange({ mode, apiKeyRecord, paperState }): Exchange
//   mode='paper' → PaperExchange（纯本地模拟，不联网）
//   mode='live'  → LiveExchange（币安 U 本位合约 REST，带签名）
//   apiKeyRecord 为 api_keys 表行（密文），内部用 decrypt() 解密
//   paperState 为机器人的 paper_json 对象，PaperExchange 直接读写它（引用同一对象）
```

### Exchange 接口（两种实现必须一致）
```js
{
  mode: 'paper' | 'live',
  async account(): { equity, walletBalance, availableBalance, unrealizedPnl, realizedPnl, positions: Position[] }
  async rules(symbol): { minQty, stepSize, tickSize, minNotional, maxLeverage, pricePrecision, qtyPrecision }
  async markPrice(symbol): number
  async position(symbol): Position | null
  async setLeverage(symbol, leverage): void
  async placeOrder({ symbol, side, type, quantity, price, reduceOnly, clientOrderId }): OrderResult
  async cancelOrder(symbol, orderId): void
  async openOrders(symbol): OrderResult[]
  async premiumIndex(symbol): { markPrice, lastFundingRate, nextFundingTime }
}
// side: 'BUY' | 'SELL'    type: 'MARKET' | 'LIMIT'
// OrderResult: { orderId, clientOrderId, symbol, side, type, qty, price, avgPrice, status, fee, ts }
// Position: { symbol, qty, entryPrice, markPrice, unrealizedPnl, leverage, liqPrice, margin, side }
```

### `src/binance/icons.js`（无，忽略）

### `src/binance/mockMarket.js` → `src/binance/index.js` 内部使用
模拟行情源：内置标的 `BTCUSDT/ETHUSDT/HYPEUSDT/SOLUSDT/BNBUSDT`，每 `PAPER.tickIntervalMs` 推进一步几何布朗运动，
24h 波动率约 `HYPEUSDT 6%`、其他 3%~4%，初始价 `HYPEUSDT 78.0`、`BTCUSDT 110000`、`ETHUSDT 4000`、
`SOLUSDT 200`、`BNBUSDT 700`。种子固定（同一进程内可复现），并提供足够 200 根 1h K 线的历史。

### MarketFeed 接口
```js
{
  symbols(): string[]                                  // 支持列表
  getPrice(symbol): number                             // 最新价（模拟：随机游走；live 模式回退到模拟，因为本机无外网）
  ticker(symbol): { price, change24hPct, high24h, low24h, volume24h }
  async klines(symbol, interval, limit): [{ t, o, h, l, c, v }]   // interval 目前只需支持 '1h'/'15m'/'4h'
  atrPct(symbol, interval = '1h', period = 14): number // ATR/最新价，返回小数（0.02 = 2%）
  isLive: boolean
}
```
**重要：本机防火墙屏蔽了币安域名（DNS 被污染、连接超时）。所有联网调用必须 8 秒超时并优雅降级为模拟数据，绝不能阻塞或抛未捕获异常。**

---

## 4. 策略层（strategy 提供）

### `src/strategy/params.js`
```js
export const PARAM_SCHEMA = [ParamDef, ...]
// ParamDef: { key, label, group, type:'percent'|'number'|'select'|'toggle',
//             default, min, max, step, options?:[{value,label}], help }
export function defaultParams(): object
export function normalizeParams(raw): object      // 夹逼到合法区间
export function validateParams(raw): { ok: boolean, errors: string[] }
```
必须包含的参数（`key` 固定，前端依赖）：
| key | 含义 | 默认 |
|---|---|---|
| `direction` | `dual`=双边 / `long`=仅做多 | `dual` |
| `k` | 首层保证金占权益比例(%) | `1` |
| `leverage` | 杠杆 | `20` |
| `kMax` | 总名义/权益 上限 | `3` |
| `dMax` | 满仓最大浮亏占权益比例(%) | `35` |
| `beta` | 网格间距 = beta × ATR | `0.4` |
| `trendGateAtr` | 趋势闸门阈值(×ATR) | `2` |
| `maxLayers` | 层数硬上限 | `10` |
| `tpMode` | `perLayer` 单层止盈 / `avg` 均价止盈 | `perLayer` |
| `stopAtr` | 硬止损 = 末层价 − stopAtr×ATR | `2` |
| `interval` | 决策周期 | `1h` |
| `initialCapital` | 模拟初始资金(USDT) | `100` |

### `src/strategy/solver.js`
```js
export function solvePlan({ equity, atrPct, price, params, rules, direction }): Plan
export function solveLayers(plan): Layer[]
// Plan: {
//   spacingPct,           // 0.008 = 0.8%
//   layers: number,       // n
//   ratio,                // 等比公比 r
//   firstLayerMargin,     // m1 = k*equity
//   firstLayerNotional,   // m1*leverage
//   notionalTotal,
//   notionalCap,
//   avgEntry,             // 满仓均价估算
//   liqPrice,             // 估算强平价
//   tpPrice, stopPrice,
//   maxLossPct,           // 满仓并跌到止损时的浮亏/权益
//   feasible: boolean,
//   notes: string[]       // 中文说明，给前端展示
// }
```

### `src/strategy/engine.js`
```js
export class RobotEngine {
  constructor({ robot, params, exchange, market, logger })
  async tick(): { actions: Action[], state: State }   // 幂等，一次一个决策周期
  async plan(): Plan                                  // 当前参数下的计划（预览用）
  snapshot(): State
}
// State: { positions: { long: Position[], short: Position[] }, avgEntry, layersUsed,
//          realizedPnl, unrealizedPnl, equity, plan, lastAction, halted, haltedReason }
// Action: { type:'OPEN'|'ADD'|'CLOSE'|'STOP'|'WARN', side, qty, price, reason }
```

### `src/strategy/runner.js`
```js
export function startRobot(robotRow): Promise<void>   // 幂等，已在跑则忽略
export function stopRobot(robotId): Promise<void>
export function isRunning(robotId): boolean
export function bootAll(): Promise<void>              // 进程启动时恢复 status='running' 的机器人
export function shutdownAll(): Promise<void>
```
Runner 内部 `setInterval(TICK_INTERVAL_MS)` 驱动 `engine.tick()`，写 `orders` 表、`events` 表、
`equity_curve` 表，并更新 `robots.state_json / paper_json / last_tick / last_error`。
日志：`logger(level, message)` 由 runner 注入，写入 `events` 表。

---

## 5. HTTP 接口（前端唯一依赖，必须逐字实现）

统一信封：成功 `{ ok: true, data: ... }`；失败 HTTP 4xx/5xx + `{ ok: false, error: { code, message } }`。
除 `/api/auth/*` 外全部需要登录。

### 认证（lead）
```
POST /api/auth/register { username, password }        -> { user }
POST /api/auth/login    { username, password }        -> { user }  + Set-Cookie: bt_sid
POST /api/auth/logout                                  -> {}
GET  /api/me                                           -> { id, username, createdAt, hasApiKey, mode:'paper' }
GET  /api/meta/defaults                                -> { params: {schema..., defaults}, modes, symbols }
```

### 行情（backend-exchange）
```
GET /api/market/symbols                     -> [{ symbol, price, change24hPct, atrPct }]
GET /api/market/klines?symbol=&interval=&limit=  -> [{ t, o, h, l, c, v }]
GET /api/market/overview?symbol=            -> { symbol, price, markPrice, atrPct, fundingRate, nextFundingTime,
                                                 high24h, low24h, volume24h, change24hPct, source:'mock'|'live' }
```

### 账户（backend-exchange）
```
GET /api/account/overview?mode=paper|live
 -> { mode, equity, walletBalance, availableBalance, unrealizedPnl, realizedPnl,
      todayPnl, positions:[{symbol,qty,entryPrice,markPrice,unrealizedPnl,liqPrice,leverage,margin,side}],
      updatedAt, live:{ configured, verified, error } }
```
`mode=live` 时若无 API Key 或联网失败：返回 `live.configured=false` / `live.error` 字符串，**不要 500**，
其余字段填 0。`mode=paper` 返回该用户所有模拟机器人资金汇总。

### API Key（backend-exchange）
```
GET    /api/apikeys           -> [{ id, label, masked, status, lastVerified, lastError, createdAt }]
POST   /api/apikeys { label, apiKey, apiSecret }  -> { id, label, masked, status }
DELETE /api/apikeys/:id
POST   /api/apikeys/:id/verify -> { status, error? }
```
**严禁在响应中返回明文 key / secret。落库前必须 `encrypt()`。**

### 机器人（lead）
```
GET    /api/robots                        -> [RobotSummary]
GET    /api/robots/:id                    -> { robot, state, plan, orders, events, equityCurve }
POST   /api/robots { name, symbol, mode, params }  -> { robot }
PATCH  /api/robots/:id { name?, params? }          -> { robot }
POST   /api/robots/:id/start
POST   /api/robots/:id/stop
POST   /api/robots/:id/reset              -> 清空模拟账本与订单，状态回 stopped
DELETE /api/robots/:id
POST   /api/robots/preview { symbol, mode, params, equity? } -> { plan }
GET    /api/robots/:id/events?limit=100   -> [{ level, message, ts }]
GET    /api/robots/:id/orders?limit=100   -> [Order]
```
`RobotSummary`: `{ id, name, symbol, mode, status, params, createdAt, startedAt, lastTick, lastError,
stats: { equity, pnlPct, totalPnl, orders, positions, halted } }`

---

## 6. 安全红线

1. API Key 只以 AES-256-GCM 密文落库；任何接口不回传明文；前端只显示 `masked`。
2. 密码用 `scrypt` + 每用户随机盐，校验用 `timingSafeEqual`。
3. 会话 Cookie `bt_sid`：`HttpOnly; SameSite=Lax; Path=/`，7 天过期。
4. 所有 SQL 使用参数绑定，禁止字符串拼接。
5. 所有写接口校验 `user_id` 归属，防止越权。
6. 登录接口做失败计数限流（同用户 5 次/分钟）。
7. 不打印、不日志化任何 key/secret/密码。

---

## 7. 前端约定（frontend）

- 单页应用，`src/static/index.html` + `app.js` + `styles.css`，**原生 JS，无构建，无 CDN**。
- 深色金融风主题（背景 `#0b0e11`、卡片 `#161a1e`、涨绿 `#0ecb81`、跌红 `#f6465d`、主色 `#f0b90b`）。
- 页面：登录/注册 → 概览 → 机器人列表 → 机器人详情 → 账户 → API Key 设置。
- 机器人创建表单**由 `GET /api/meta/defaults` 返回的 schema 动态渲染**，不得硬编码字段。
- 参数表单实时调用 `POST /api/robots/preview` 展示求解结果（层数、公比、每层金额、爆仓价、最大回撤）。
- 轮询刷新：概览/详情 3 秒一次，机器人列表 3 秒一次。
- 数字格式：金额 2 位小数，百分比 2 位小数，价格按标的精度。
- 所有文案中文。
