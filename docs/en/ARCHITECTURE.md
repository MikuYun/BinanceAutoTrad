**English** ｜ [中文](../ARCHITECTURE.md) ｜ [日本語](../ja/ARCHITECTURE.md)

# Code Architecture and Reading Guide

> For anyone who wants to understand this codebase, or to roll up their sleeves and change it. Every conclusion in this document comes from the actual code in the repository.

---

## I. What this project is and why this stack

### In one sentence

A Binance USDⓈ-M perpetual-futures automated trading platform built with **zero third-party dependencies, a single process, and nothing but Node built-in modules**:
the backend is a minimal HTTP service plus SQLite, the frontend is a vanilla-JS single-page app,
and the strategy layer drives paper-mode or live orders with "add at fixed levels, take profit at the average price".

### Why this stack

| Choice | Reality | Why it was done this way |
|---|---|---|
| Zero third-party dependencies | `package.json` has no `dependencies` / `devDependencies` | A trading bot has to run unattended for a long time on unfamiliar machines. The bigger the dependency tree, the higher the supply-chain risk. Zero dependencies makes "clone → `node server.js`" the only deployment path there is |
| Database `node:sqlite` | `src/db.js` does `import { DatabaseSync } from 'node:sqlite'` directly | A single process with a single user does not need a database server. File-based SQLite brings transactions and WAL with it, and a backup is one file copy; the built-in module **needs no native compilation**, so there are no build tools to install on Windows |
| No Python / FastAPI | Frontend and backend in one language | The strategy layer is a lot of numeric work and JS's IEEE-754 doubles are enough; more importantly, **both ends share one parameter schema** (`PARAM_SCHEMA` drives backend validation and the frontend form at the same time), which removes a whole duplicated definition |
| No React / Vue | `src/static/app.js` is 1655 lines of vanilla ESM | There are only 6 views, so no virtual DOM and no build chain. Edit, refresh, done — there is no `npm run build` layer |
| No web framework | `src/http.js` is a 324-line hand-written Router | 28 endpoints in total, all of them static path segments plus one `:id`. A hand-written Router is less work than reading a framework's middleware execution order closely enough to trust it |

**Version requirement**: `engines.node` in `package.json` is `>=22.5.0`, because `node:sqlite` only shipped with Node 22.5 and anything older throws on startup. Node 24 LTS is what you actually want.

---

## II. Architecture diagram

```
┌ Browser SPA  src/static/  index.html + app.js + styles.css
│   hash routing #/dashboard #/robots #/account #/apikeys · pure SVG charts · 3s polling
└──────────────┬───────────────────────────────────────────────────
               │ HTTP (JSON)
┌──────────────▼───────────────────────────────────────────────────
│ HTTP layer  src/http.js
│ Router / middleware / body parsing / cookies / static hosting / BASE_PATH stripping
│ unified envelope { ok, data } | { ok:false, error:{ code, message } }
└──────────────┬───────────────────────────────────────────────────
               │ ctx = { req, res, params, query, body, user, cookies }
┌──────────────▼───────────────────────────────────────────────────
│ Auth src/auth.js (the first middleware, injects ctx.user)
│ Routes src/routers/  auth · robots · market · account · apikeys
└───────┬──────────────────────────┬────────────────────────────────
        │ preview/validate/start-stop │ account and market queries
┌───────▼──────────────────┐  ┌────▼───────────────────────────────
│ Strategy src/strategy/   │  │ Market src/binance/
│  params     param schema │  │  index.js → getMarketFeed()
│  solver     math (pure)  │  │    ├ liveMarket  real market data
│  engine     decision FSM │  │    └ mockMarket  local simulation
│  runner     orchestration│  │  protection.js resting-order detection
│  wallet     paper wallet │  └────────────────────────────────────
│  liveBook   live ledger  │
│  protect    cond. intent │
│  accountStats snapshots  │
└───────┬──────────────────┘
        │ getExchange(mode) → paper | live  (same interface)
┌───────▼──────────────────────────────────────────────────────────
│ Exchange adapter layer src/binance/
│  paper.js local matching (0.05% fee + 0.02% slippage)
│  live.js  real orders (precision normalisation / idempotent id / conditional orders)
│  rest.js  signed client (hard timeout / clock sync / bounded retries)
└───────┬──────────────────────────────────────────────────────────
        │ /fapi/v1/*  /fapi/v2/*
   ┌────▼─────┐        Persistence data/app.db (WAL)
   │ Binance  │        Keys        data/master.key (0600)
   └──────────┘
```

---

## III. Directory structure, item by item

### Root

| File | Responsibility |
|---|---|
| `server.js` | Entry-point wiring: middleware and routes, starting the market feed and clock sync, restoring bots that were running, graceful shutdown |
| `package.json` | Only the three scripts `start` / `check` / `test`; no dependencies at all |
| `README.md` | For users: what it is, how to run it, how to tune the parameters, risk warnings |
| `DEPLOY.md` | For operators: systemd, Nginx reverse proxy, HTTPS, backups, upgrade and rollback |
| `LICENSE` | Apache License 2.0 |
| `data/` | Created automatically at runtime, **never committed to git**: `app.db`, `master.key`, `rules-cache.json` |

### Backend core

| File | Lines | Responsibility |
|---|---|---|
| `src/config.js` | 108 | Global configuration: `PORT` / `HOST` / `BASE_PATH` / `LIVE_TRADING` / `BT_MASTER_KEY` / `BINANCE` / `PAPER`, plus loading and auto-generating `MASTER_KEY` |
| `src/db.js` | 191 | The SQLite access layer: tables, indexes, `ALTER` upgrades for older databases; exports `all` / `get` / `run` / `tx` |
| `src/http.js` | 324 | The minimal HTTP framework: `Router`, `HttpError`, body parsing, cookies, static hosting, prefix stripping, unified error responses |
| `src/crypto.js` | 124 | AES-256-GCM encryption, `maskKey`, scrypt password hashing and `timingSafeEqual` verification, `randomId`, HMAC-SHA256, SHA-256 |
| `src/auth.js` | 178 | Accounts and sessions: registration, login, the `bt_sid` cookie, login-failure rate limiting, `authMiddleware` |

### Routing layer `src/routers/` (5 modules, 28 endpoints in total)

| File | Endpoints | Responsibility |
|---|---|---|
| `auth.js` | 5 | Register / log in / log out, `GET /api/me`, `GET /api/meta/defaults` (parameter schema and instrument list) |
| `robots.js` | 11 | Bot CRUD, the `preview` dry run, start / stop / reset, events and order history |
| `market.js` | 4 | Instrument list, candlesticks, market overview, connectivity health check |
| `account.js` | 4 | Account overview (paper / live), account-level equity curve, paper wallet read/write |
| `apikeys.js` | 4 | Add, delete and list API keys, plus one Binance round trip to 「验证」 (verify) a key |

### Exchange adapter layer `src/binance/`

| File | Lines | Responsibility |
|---|---|---|
| `rest.js` | 423 | Binance REST client: signing, `recvWindow`, clock-offset calibration, hard timeouts, retries only for idempotent requests |
| `live.js` | 605 | Live mode: precision normalisation, deterministic `clientOrderId`, orders / conditional orders / cancellations, account reads, three-tier rule cache |
| `paper.js` | 266 | Paper-mode matching: opening, closing a whole side, per-tranche closing, equity and snapshots |
| `liveMarket.js` | 356 | Live market data: background timers refresh prices and the 24h ticker; the synchronous API only reads the in-memory cache |
| `mockMarket.js` | 248 | Offline market data: geometric Brownian motion plus mean reversion, deterministic and reproducible |
| `index.js` | 71 | The single entry point: `getMarketFeed()`, `startMarket()`, `getExchange(mode)`, `loadCredentials(userId)` |
| `protection.js` | 153 | Recognises take-profit and stop-loss orders from Binance's real resting orders, and clamps the stop between the entry price and the liquidation price |

### Strategy layer `src/strategy/`

| File | Lines | Responsibility |
|---|---|---|
| `params.js` | 371 | Parameter schema, defaults, normalisation of old parameter names, parameter validation (including the minimum-order-amount check) |
| `solver.js` | 524 | Pure maths: minimum order amount, liquidation price, take-profit and stop-loss targets, the add-on ladder, feasibility |
| `engine.js` | 259 | Decision state machine: turns "position + market + plan" into a set of `action`s |
| `runner.js` | 1087 | Orchestrator: one timer per bot, chaining market data → ledger → decision → execution → persistence |
| `wallet.js` | 243 | The account-level shared paper wallet: cash in `paper_accounts`, positions in `robots.paper_json` |
| `liveBook.js` | 174 | The live bot's own position ledger `liveLegs`, reconciled against the exchange to isolate the user's manual positions |
| `protect.js` | 192 | Protective-order intent: works out which take-profits and stop-losses should be resting, then diffs that against what is already placed |
| `accountStats.js` | 250 | Account-level equity snapshots, the daily baseline, the account curve and today's P&L |

### Frontend and scripts

| File | Lines | Responsibility |
|---|---|---|
| `src/static/index.html` | 46 | The single-page shell: navigation, restoring the theme on first paint, the mount point |
| `src/static/app.js` | 1655 | All frontend logic: hash routing, polling, partial refresh, schema-driven forms, pure-SVG charts |
| `src/static/styles.css` | 320 | CSS variables and layout for four themes (dark / light / blue / warm) |
| `scripts/check.js` | 52 | The zero-dependency self-check: `node --check` over everything plus key-file existence |
| `scripts/test-*.mjs` | 839 | 6 groups of unit tests, 64 cases |

About **10.5k lines** in total.

---

## IV. Request lifecycle

Taking `POST /api/robots/:id/start` as the example:

| # | Stage | What happens |
|---|---|---|
| ① | `http.createServer` | `src/http.js` receives the request and pulls the pathname and query out with `new URL(req.url, 'http://localhost')` |
| ② | BASE_PATH stripping | Deployed under `/biance_trae`, `/biance_trae/api/...` is stripped to `/api/...` first, and the cookie Path carries the prefix too |
| ③ | Building ctx | `{ req, res, params:{}, query, body:{}, user:null, cookies:parseCookies(...) }` |
| ④ | Middleware | There is exactly one: `authMiddleware(ctx)` → resolves the session from `bt_sid` and injects `ctx.user` |
| ⑤ | Route matching | `matchRoute('POST', pathname)`: the segment counts must be equal, and a `:id` segment is `decodeURIComponent`-ed into `params` |
| ⑥ | Body parsing | Only POST / PATCH / DELETE read a body; over 1MB throws `413 BODY_TOO_LARGE`, non-JSON throws `400 BAD_BODY` |
| ⑦ | Handler | `routes/robots.js`: `requireAuth` → `ownedRobot(userId, id)` (`WHERE id=? AND user_id=?`; no row means 404, which also blocks privilege escalation) |
| ⑧ | Business gates | live and `!TRADING.liveEnabled` → `400 LIVE_DISABLED`; live with no verified Key → `400 NO_API_KEY` |
| ⑨ | Side effects | `UPDATE robots SET status='running'` + `logEvent('机器人启动')` + `runner.startRobot(fresh)` |
| ⑩ | Response | If the handler returns something that is not `undefined` and headers have not been sent, `ok(ctx, result)` wraps it automatically; `Content-Type` / `Content-Length` / `Cache-Control: no-store` are written |
| ⑪ | Errors | `HttpError` → `fail(status, code, message)`; anything else → `500 INTERNAL_ERROR`, and internal details are never sent back to the frontend |

Two things worth knowing: `authMiddleware` must be the **first** middleware registered; and every business error is `throw new HttpError(status, CODE, '中文提示')` (a Chinese message), so the frontend only branches on `error.code` and toasts `error.message` as-is.

---

## V. Bot tick lifecycle

`startRobot()` calls `setInterval(TICK.intervalMs)` (default **5000ms**, adjustable with `TICK_INTERVAL_MS`) and runs one tick **immediately**, without waiting for the first interval.

| # | Step | Key behaviour |
|---|---|---|
| 1 | Fetch market data | `feed.getPrice(symbol)` + `feed.atrPctAsync(symbol, params.interval\|\|'1h')`; on error it logs a `warn` event and `return`s |
| 2 | Validate the price | `price > 0`, otherwise it writes 「当前价格无效，跳过本次决策」 (current price invalid, skipping this decision) |
| 3 | Pull candlesticks | `klinesAsync(symbol, interval, 60)`, degrading to an empty array on failure |
| 4 | Confirm it is still running | Re-query `SELECT * FROM robots WHERE id=?`; if `status !== 'running'`, `stopRobot` and pack up |
| 5 | Fetch the rules | `getExchange(mode)`; live uses `getLiveRules(symbol)` (10-minute cache), paper uses `PAPER_RULES` |
| 6 | Work out the money | paper: `getWallet` + `mergeBook(paper_json, wallet)` to assemble the book, then `equityOf(book, price)`; live: `loadCredentials` → `fetchAccount` to read real equity, and it **must** `filterBySymbol(quote.positions, symbol)` |
| 7 | Live reconciliation | `parseLiveLegs` + `reconcile(legs, quote.positions)`: anything extra is a manual position (`info`, throttled), anything missing shrinks the ledger proportionally (`warn`) |
| 8 | Equity gate | `equity <= 0` → 「权益为 0，无法计算仓位」 (equity is 0, cannot size the position) and return |
| 9 | Fix the anchor | Holding → keep `state.anchorPrice`; flat → use the current price (trigger prices do not drift while a position is open) |
| 10 | Solve the plan | `decide({...})` calls `solvePlan` internally, then produces `actions` / `notes` according to the position state |
| 11 | Record the reasoning | Each entry in `result.notes` becomes an `info` event, visible straight away on the detail page |
| 12 | The no-action branch | Even with nothing to do, live mode writes the reconciled ledger back to `state_json` (otherwise the ledger never converges after a manual close); `recordAccountEquity` → `saveRobot({last_tick})` → `recordEquity`; every 60 seconds `syncProtection` re-checks that the exchange-side take-profit and stop-loss are still there |
| 13 | Execute the actions | Walk `actions` one by one, checking `entry.stopped` at the top of each (so pressing Stop halts immediately) |
| 14 | Paper order | Validate the available balance with `availableForUser(userId)` first, then `exchange.openPosition(...)`; failures log a `warn` |
| 15 | Live order | **Pass the safety gate first**: `if (!TRADING.liveEnabled)` writes 「本次只读取行情与账户，不会向币安发送任何订单」 (this run only reads market data and the account; no order will be sent to Binance) and `continue`s; only then `placeOrder` + `addLeg` bookkeeping |
| 16 | Close bookkeeping | paper goes through `closeLegs` (per-tranche take-profit) / `closeSide`; live only closes the `ownQty` in its own ledger and derives `realizedPnl` from the weighted average price of the closed part |
| 17 | Persist | `recordOrder` writes `orders`; `applyWalletDelta` + `splitBook` write back to the wallet and `paper_json`; `saveRobot` updates `state_json` |
| 18 | Write events | `logEvent` writes `events`, which the frontend event stream consumes directly |

Re-entrancy protection: when `entry.ticking` is true the round is skipped — a market-data call slower than 5 seconds never stacks two concurrent decisions.

---

## VI. How the four strategy files divide the work

The dividing line is "**who is allowed to touch IO**":

| File | IO allowed | Input | Output | In one sentence |
|---|---|---|---|---|
| `params.js` | No | Raw JSON from the frontend | Normalised, complete parameters + validation result | Defines 「用户能填什么」 (what the user may fill in) |
| `solver.js` | **No, pure functions** | `{equity, price, params, rules, anchorPrice, realizedPnl}` | The full plan (layer count, each layer's notional and trigger price, average price, liquidation price, take-profit and stop-loss prices, feasibility) | Works out 「数学上该怎么下单」 (how the orders should be placed, mathematically) |
| `engine.js` | No | `{params, book, markPrice, equity, rules, quote, anchorPrice, realizedPnl}` | `{ actions, plan, halted, notes }` | Decides 「此刻该开首笔 / 加仓 / 止盈 / 止损 / 不动」 (open the first tranche / add / take profit / stop out / do nothing right now) |
| `runner.js` | **Yes, the only IO exit** | One bot id | Side effects: orders, database writes, events | Chains the three layers above every 5 seconds |

**`params.js`**: `PARAM_SCHEMA` is a 13-item array, each item `{ key, label, group, type, default, options?, min, max, step, help }`, and it is simultaneously the definition source for the frontend form (`renderSchemaForm`) and for backend validation — adding a parameter means changing this one place. `normalizeParams(raw)` first maps old parameter names onto new ones (`k`→`firstPct`, `beta`→`spacingPct`, `kMax`→`totalPct`, `dMax`→`maxLossPct`, `stopAtr`→`stopPct`, `initialCapital`→`allocatedCapital`), then clamps and whitelist-filters against the schema so the output always carries every field. `validateParams(params, {minNotional, minQty, stepSize, price})` returns `{ok, errors, warnings, params}`: hard errors are combinations that produce no usable result, such as "the first tranche's notional is below the real minimum order amount"; warnings are combinations that run but run badly, such as "the stop-loss room is tighter than the add-on spacing".

**`solver.js`**: no `fetch`, no database, no business-related `Date.now()`, so unit tests can call it directly. Core functions:

| Function | What it does |
|---|---|
| `requiredQtyUnits` / `qtyUnitsOf` | Convert a notional amount into "how many minimum quantity steps" |
| `minOrderNotional(price, rules)` | The **real** minimum order notional = `max(exchange minNotional, minimum quantity × stepSize × price)` |
| `canPlaceNotional(notional, price, rules)` | The boolean version of the line above |
| `liqPrice(qty, avgEntry, equity, side)` | An approximation of the cross-margin liquidation price; `equity` must be the account's real equity |
| `tpTargetFor` / `stopTargetFor` / `safeStop` | Take-profit is computed from the **current actual average price**; the stop-loss is computed from `stopPct` and then clamped between the entry price and the liquidation price |
| `solvePlan(input)` | The main entry point: tries layer counts downward from `maxLayers` until the notional cap, the loss budget and "stop-loss before liquidation" all hold at the same time |
| `solveLayers(plan)` | Hands `plan.layerList` to the frontend to draw the ladder table |

**`engine.js`**: the state machine is `IDLE ──建首层──▶ HOLDING ──踩到间距──▶ 加仓 ──▶ FULL ──止盈/止损──▶ IDLE` (IDLE --open the first layer--> HOLDING --spacing reached--> add-on --> FULL --take-profit/stop-loss--> IDLE). The branch order inside `decide()` is fixed and deliberate: first compute `sideState`, then `solvePlan`; if the plan is infeasible it returns only `notes`; then, per side, **open the first tranche while flat ＞ stop-loss ＞ take-profit ＞ add-on** (survive first, bank second, add last). Every open passes two gates: `canPlaceNotional` and `ownUsedMargin + new usage <= capitalBudget`.

**`runner.js`**: `running` is a `Map<robotId, entry>`, managed by `startRobot` / `stopRobot` / `bootAll` / `shutdownAll`; it translates `actions` into real `placeOrder` / `openPosition` / `closeSide` calls; and all four database writers — `saveRobot` / `recordOrder` / `recordEquity` / `logEvent` — are wrapped in `try/catch`, because a failed log write must never stop the trading.

---

## VII. The two implementations of the exchange adapter layer

`src/binance/index.js` makes one choice: `mode === 'live' ? liveExchange : paperExchange`, and both objects carry a `type` field. `runner.js` only uses a subset of their capabilities:

| Call site | paper implementation | live implementation |
|---|---|---|
| Read equity | `equityOf(book, markPrice)`, computed locally | `fetchAccount(creds)`, read from the exchange |
| Open | `openPosition(book, {...})`, append one leg locally | `placeOrder(...)`, send a real market order and then `addLeg` |
| Close | `closeSide` / `closeLegs`, decrement locally | `placeOrder(reduceOnly)`, with P&L from the weighted average of the closed part |
| Precision rules | The `PAPER_RULES` constant | `getRules(symbol)` via `exchangeInfo`, falling back to the on-disk cache |

`closeLegs` does not exist on both sides: `runner.js` probes with `typeof exchange.closeLegs === 'function'` before going the per-tranche take-profit route, and otherwise falls back to closing the whole side. That is deliberate **capability detection**, not a hard interface contract.

On the market side, `liveMarket` and `mockMarket` export objects with the **same names and the same shapes**, and `index.js` picks one based on `process.env.BINANCE_FEED === 'mock'`:

| Capability | `liveMarket` | `mockMarket` |
|---|---|---|
| Synchronous API | Reads the in-memory cache only (a `quotes` Map), never blocking the event loop | Computed on the spot, so always available |
| Asynchronous API | `atrPctAsync` / `klinesAsync` hit the network directly | Generates OHLCV by random walk, then computes ATR |
| Refresh | Background timers: prices 3s, ticker 30s, instrument list 5min | `tickMarket()` is pushed by `server.js` every 3s |
| Failure behaviour | Degrades to mock prices and flags `degraded: true` | Failure does not exist |

---

## VIII. Data flow and persistence

`app.db` holds **10 tables**: 7 core business tables plus 3 supporting tables.

| Table | Primary key | Responsibility | Who writes it |
|---|---|---|---|
| `users` | `id` | Accounts: username, scrypt password hash, creation time | `auth.js` |
| `api_keys` | `id` | Encrypted Key / Secret, masked value, verification status and last error | `routers/apikeys.js` |
| `robots` | `id` | Instrument, mode, status, `params_json`, `state_json`, `paper_json` | `routers/robots.js`, `runner.js` |
| `paper_accounts` | `user_id` | The account-level shared paper wallet: balance, initial balance, realised P&L, cumulative fees | `wallet.js` |
| `orders` | `id` (`client_id` unique) | Order history: average fill price, fee, `realized_pnl`, `reduce_only` | `recordOrder` |
| `equity_curve` | auto-increment | **Per-bot** equity curve points: time, equity, price, position size | `recordEquity` |
| `events` | auto-increment | The bot event stream (`info`/`warn`/`error`/`trade`), read directly by the detail page | `logEvent` |
| `sessions` | `id` | Login sessions: token, user, expiry, UA; cleaned up by `purgeExpiredSessions()` | `auth.js` |
| `account_equity` | auto-increment | **Account-level** equity snapshots, written with a 15-second throttle, keeping only the latest 5000 rows | `accountStats.js` |
| `account_daily` | `(user_id, mode, day)` | The daily opening baseline; today's P&L = current equity − the day's baseline | `accountStats.js` |

Why split "per-bot `equity_curve`" and "account-level `account_equity`" into two tables? Paper money lives in a **wallet shared by the whole account**, so a single bot's curve only represents that one bot: use it as the overview curve and the moment the user changes the wallet balance the curve falls off a cliff, while two bots with very different capital bases stretch the same coordinate system until nothing is readable.

### The relationship between `paper_accounts` and `robots.paper_json`

This is the easiest thing to get wrong: **cash and positions are stored in two different places**.

```
paper_accounts（每用户一行，账户级 — one row per user, account level）
  balance / initial_balance / realized_pnl / fee_paid
robots.paper_json（每机器人一份，机器人级 — one copy per bot, bot level）
  positions.long[] / positions.short[] / realizedPnl / feePaid / lastPrice
```

Every tick, `mergeBook(robotBook, wallet)` assembles the complete book for `paper.js`, and after the calculation `splitBook(book)` splits it back apart so each half can be written where it belongs. This mirrors how a real Binance cross-margin account behaves: several paper bots share one pool of available balance, whoever reserves margin first gets it, and if there is not enough, no position can be opened. If every bot stored its own balance, "I have 100U, so I will run two bots with 100U each" would conjure 200U out of thin air.

### Where live mode persists

Live mode has no concept of "cash"; equity is always read from the exchange. `robots.state_json` stores: `liveLegs` (the bot's own position ledger), `condOrders` (a snapshot of the protective orders already placed, used for differential sync), `anchorPrice`, `realizedPnl` (folded into the capital base on the next tick), `manualNotice` (throttling for manual-position notices), and `equity` / `balance` / `positions` (the most recent exchange state read, for the frontend to render).

---

## IX. Key design decisions (and why)

**1. Deterministic `clientOrderId` for idempotency**
`makeClientId(robotId, side, layer, action, bucketMs = 300000)` is built from the bot id + side + layer number + action + a 5-minute time bucket, with no randomness. The reason is a real scenario: a request goes out, the response never comes back, and you do not know whether it filled. A random id would **really open another position** when the next tick re-sends; a deterministic id gets rejected by Binance as a duplicate `clientOrderId` (`-4015` / `-4116`), and a lookup by that id (`recoverByClientId`) then tells you the first order did fill. For the same reason `rest.js` **only retries `GET` and the cancellation `DELETE`, and never automatically retries an order `POST`** — a timeout does not mean the order did not fill.

**2. A separate live position ledger, `liveLegs`**
Under Binance USDⓈ-M hedge mode, longs in the same symbol are **aggregated at account level**: `positionRisk` only tells you 「这个币有多单 4.37 张」 (this symbol has 4.37 long contracts) and cannot tell which of them the bot opened. Treating the whole thing as your own would let the bot close positions the user opened by hand — an accident involving real money. So each live bot keeps its own ledger in `state_json.liveLegs`: `addLeg` on a successful open, `drainQty` / `drainLegs` by quantity on a close, and `reconcile` every tick — anything the exchange shows **extra** is a manual position (notify only, never touch it), anything **missing** shrinks the ledger proportionally. The ledger is only used for layer counts, average price and closable quantity; **equity always comes from the exchange's real value**.

**3. Clock-offset calibration**
The `timestamp` on a signed request has to fall inside `recvWindow`, otherwise you get `-1021`. Behind a reverse proxy a one-way trip can be hundreds of milliseconds to several seconds, and the local clock can drift too. `rest.js`'s `syncTime()` requests `/fapi/v1/time` and estimates `timeOffsetMs` from the **round-trip midpoint**, after which everything uses `Date.now() + offset`; `startTimeSync()` recalibrates every 60 seconds (`BINANCE_TIME_SYNC_MS`, clamped to 10s–600s); and on `-1021` / `-1022` it forces a re-sync and retries once. `recvWindow` defaults to 5000ms and `BINANCE_RECV_WINDOW` can set it anywhere from 1000 to 60000.

**4. The precision rule cache `rules-cache.json`**
The exchange imposes a step size on both quantity and price, and one extra decimal is `-1111`. But an `exchangeInfo` response is about 1.1MB across a thousand-plus contracts, so it cannot be fetched per order. `live.js` does three tiers: an in-memory `Map` (10-minute TTL) → the on-disk `data/rules-cache.json` (0600) → the `HARDCODED_RULES` fallback flagged `degraded: true`. **Degraded rules are never cached**, so one network wobble cannot fossilise the wrong precision. There is one more layer when placing an order: `precisionAttempts()` steps quantity and trigger price down together (at most 4 steps), each step must still clear the minimum notional, and a `-1111` moves on to the next step. `parseFilters()` takes the **coarser** of `LOT_SIZE` and `MARKET_LOT_SIZE`, because market orders are validated against `MARKET_LOT_SIZE`.

**5. The `LIVE_TRADING` safety gate**
`config.js` has just one line, `export const TRADING = { liveEnabled: process.env.LIVE_TRADING === '1' }`, but it is checked in three places, forming defence in depth: the start route in `routers/robots.js` refuses to start a live bot (`400 LIVE_DISABLED`); `runner.js` intercepts every live order before it is placed and logs a `warn`; and the live tick still reads prices and the account, so the page data stays alive. The default is **off**; turning it on requires explicitly adding `LIVE_TRADING=1` to the start command, and a restart puts it back to off.

**6. The price anchor `anchorPrice`**
`anchorPrice` is taken from the price at the moment the bot was **flat**, and then kept for as long as the position is open, until it is fully closed and a new anchor is taken. Without a fixed anchor, trigger prices would slide with the live price: as price falls the add-on line follows it down, so **price can never reach an add-on**; as price rises the take-profit target drifts up with it, so it can never be hit either. Once fixed, layer N's trigger price is determined the moment the position opens, which makes the behaviour reproducible and unit-testable (`test-capital.mjs` has a case for 「同一 anchorPrice 产出的阶梯完全一致」 — the same anchorPrice produces an identical ladder).

---

## X. Tests and self-checks

**`node scripts/check.js`** (52 lines, zero dependencies) does two things: it recursively `walk(ROOT)`s collecting every `.js` file (skipping `node_modules`, `data`, `.git`) and `spawnSync(process.execPath, ['--check', file])`s each one, checking syntax without executing it; then it checks that key files exist (`server.js`, `package.json`, `src/static/index.html`, `src/static/app.js`, `src/static/styles.css`). It prints `检查 JS 文件 N 个，语法错误 M 个。` (N JS files checked, M syntax errors), sets `process.exitCode = 1` on any failure, and prints `✅ 全部通过` (all passed) when everything is clean.

**6 groups of unit tests**, all using `node:test` + `node:assert/strict` with no test-framework dependency, **64 cases** in total:

| File | Cases | What it tests |
|---|---|---|
| `test-capital.mjs` | 10 | Sizing uses `allocatedCapital` rather than account equity; too little capital is judged infeasible; cumulative add-on usage stays within budget; it adds only after a drop to the spacing, and the average price is diluted; the ladder is identical for a fixed anchor; the capital base = allocated capital + realised P&L; after being wiped out it sits at zero and never goes negative; once profit is folded into the base the ladder scales with it; `decide` passes `realizedPnl` through |
| `test-minqty.mjs` | 8 | The edge where "the notional is enough but the quantity will not round to a single minimum step": `requiredQtyUnits` / `qtyUnitsOf` / `minOrderNotional` / `canPlaceNotional`; a coarse-step instrument is judged infeasible with a Chinese message; exactly one step is workable; BTC is still governed by the notional floor; `decide` places nothing when capital is short |
| `test-precision.mjs` | 12 | Precision rules: stock-style perpetuals (`TRADIFI_PERPETUAL`) must count as tradable; delivery and delisted instruments are excluded; `parseFilters` parses real filters; `MARKET_LOT_SIZE` wins when it is coarser and falls back to `LOT_SIZE` when it is absent; precision-reduction candidates are only offered while the notional still clears; conditional-order quantity and trigger price step down together; `fmtPrice` rounds by `tickSize`; `stepSize=1` rounds to integers; scientific-notation step sizes |
| `test-protect.mjs` | 10 | Protective-order intent: `avg` mode gives one pair per side, `layer` mode gives one take-profit per tranche and only one stop-loss; short positions point the other way; the stop is clamped between entry and liquidation; insufficient notional goes into `skipped`; no position produces no orders; `diffCondOrders` does not re-send the same id / cancels and re-places when the trigger price changes / cleans up orders that have vanished from the exchange; `normalizeCondOrders` handles both historical shapes |
| `test-protection.mjs` | 6 | Recognising the directional semantics of take-profit and stop-loss from Binance's **real resting orders**; with no resting orders `source='none'` and the prices come back as 0 (the platform should not invent prices); `clampStopToLiq` pulls a stop that flipped to the wrong side back where it belongs |
| `test-livebook.mjs` | 10 | The `liveLegs` ledger: accumulation and weighted average price, dirty data not entering the books, three-way reconciliation (extra → manual position / missing → proportional shrink / fully closed → zeroed), the average price staying put when quantity is deducted, per-tranche closing touching only the named tranches, the `bookOf` shape, `parseLiveLegs` tolerance, `filterBySymbol` keeping only this instrument |

```bash
node scripts/check.js        # syntax self-check
node --test scripts/*.mjs    # all unit tests
```

`npm run check` / `npm test` work too.

---

## XI. A guide to extending the code

### Adding a new strategy

**Approach A: replace only the algorithm, reuse the scheduling and persistence (recommended)**

| File to touch | How |
|---|---|
| `src/strategy/solver.js` | Add a new solver function that returns a plan object of the same shape (at least `feasible` / `layers` / `layerList` / `tpPrice` / `stopPrice`) |
| `src/strategy/engine.js` | Dispatch to the different solvers inside `decide()` based on parameters, keeping the `actions` structure unchanged |
| `src/strategy/params.js` | Add the parameters to `PARAM_SCHEMA` (they appear in the frontend form automatically) and add fallbacks in `normalizeParams` |
| `src/strategy/runner.js` | **Usually untouched** — it only consumes the agreed fields of `actions` |

The `actions` contract is `{ type:'open'|'close', side:'long'|'short', layer, notional, price, reason, legIds? }`; as long as the produced `actions` match that shape, execution, bookkeeping, persistence and event writing all need no changes.

**Approach B: add a new scheduler.** If the new strategy's rhythm is not "check every 5 seconds" at all (event-driven, say), write another module against `runner.js`'s interface, implementing `startRobot` / `stopRobot` / `isRunning` / `bootAll` / `shutdownAll`, then dispatch on the `robot.strategy` field in `server.js` and `routers/robots.js`. Adding one column to the `robots` table is enough, and `db.js` already contains the "check whether the column exists, then `ALTER TABLE`" upgrade pattern you can copy.

### Connecting another exchange

Only the adapter layer needs work; **not one line of the strategy layer changes**:

| Step | File | Notes |
|---|---|---|
| 1 | New `src/binance/<exchange>.js` | Implement the exchange object: `type`, `fetchAccount` (live side) / `equityOf` (paper side), `openPosition` / `placeOrder`, `closeSide`, `getRules` |
| 2 | New `src/binance/<exchange>Market.js` | The market-data source, exporting an object with the same names and shape as `liveMarket` / `mockMarket`: `getPrice` / `ticker` / `atrPct` / `klines` / `funding` / `symbols` / `ping` / `health`, plus the `*Async` versions |
| 3 | Edit `src/binance/index.js` | Add branches to `getMarketFeed()` and `getExchange()`; change `loadCredentials` too if the fields differ |
| 4 | New `<exchange>Protection.js` (if needed) | Follow the shape of `src/binance/protection.js`: `protectionFromOrders(orders, {symbol, side, markPrice})` |
| 5 | Add tests | Add `scripts/test-<exchange>.mjs` and test precision normalisation and the idempotent id with fake data — **do not** send real requests in unit tests |

Three pieces of semantics will very likely need rewriting after a switch: **precision rules** (`parseFilters` / `precisionAttempts` are shaped around Binance's `exchangeInfo`), **the idempotency mechanism** (it relies on the exchange deduplicating client order ids), and **position mode** (`liveLegs` assumes "the exchange aggregates positions by symbol + side"; if the new exchange can tell positions apart by order, this whole layer can be simplified).

### Adding an HTTP endpoint

1. Add `app.get/post/...` in the matching `src/routers/*.js`; the path does **not** include the `/api` prefix (the framework already routes on `/api`, so you literally write `/robots/:id/xxx`);
2. Business errors are uniformly `throw new HttpError(4xx, 'CODE', '中文提示')` (a Chinese message);
3. Return a plain object and the framework wraps it as `{ ok: true, data }`;
4. Anything involving resource ownership starts with `ownedRobot(userId, id)` — `WHERE id=? AND user_id=?` does the lookup and the privilege check in one go.

---

## XII. Further reading

| If you want to know | Look here |
|---|---|
| How to use it, what to click | [README.en.md](../../README.en.md) |
| The mathematical meaning of each of the 13 parameters | [STRATEGY.md](STRATEGY.md) |
| Deploying to a server, systemd, HTTPS | [DEPLOY.en.md](../../DEPLOY.en.md) |
| Security policy and vulnerability reporting | [SECURITY.en.md](../../SECURITY.en.md) |
| How to contribute code | [CONTRIBUTING.en.md](../../CONTRIBUTING.en.md) |
