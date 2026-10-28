**English** ｜ [中文](README.md) ｜ [日本語](README.ja.md)

# Binance Auto Trading Bot · BinanceAutoTrad

> A Binance futures bot with a web UI: **add to the position in several steps as price falls to average the cost down, then take profit when a bounce gets you back in the green**.
> Paper and live trading supported, **zero third-party dependencies**, one command to start.

[![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-brightgreen)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue)]()
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)]()

---

## Table of Contents

- [What Is This](#what-is-this)
- [Who It's For, and Who It Isn't](#who-its-for-and-who-it-isnt)
- [What the UI Looks Like](#what-the-ui-looks-like)
- [Up and Running in 3 Minutes](#up-and-running-in-3-minutes)
- [How It Works](#how-it-works)
- [Tuning the Parameters](#tuning-the-parameters)
- [Paper Trading vs. Live Trading](#paper-trading-vs-live-trading)
- [Security Design](#security-design)
- [Risk Disclosure (Must Read)](#risk-disclosure-must-read)
- [Documentation](#documentation)
- [Project Structure](#project-structure)
- [FAQ](#faq)
- [Contributing](#contributing)

---

## What Is This

### The One-Sentence Version

You set a few parameters in the web UI (how much capital, how far price has to fall before each add, how much profit to take), and the bot watches the market by itself: **it adds one position at a time on the way down to drag the average cost lower, takes profit on everything once price bounces back**, and then starts the next round.

### An Example (Not a Promise of Returns, Just the Mechanism)

Say you allocate 100 USDT and use 20x leverage:

| What happens | What the bot does |
|---|---|
| Price is 100, bot starts watching | Opens the 1st long, 20U notional |
| Price falls to 99 (−1%) | Adds a 2nd entry, 30U notional — average cost goes down |
| Price falls to 98 (−1% more) | Adds a 3rd entry, 45U notional — average cost goes down again |
| Price bounces back to average cost +0.5% | **Closes everything at a profit**, the round ends, it waits for the next opportunity |
| Price keeps falling, no bounce | Keeps adding as planned until 「层数上限」 (max layers) is used up |
| Price falls too far, past the configured stop loss | Accepts the loss, closes, and stops adding |

It also opens a mirror-image short on the **opposite side** (this can be turned off), so it has a chance whether price goes up or down.

> There is no standard name for this logic in the community. You can think of it as **「定点加仓 + 均价止盈」 (staged adds + average-price take profit)**,
> or as a grid that only fires in one direction.

### How It Differs from a Typical "Grid Bot"

| | Ordinary grid | This project |
|---|---|---|
| Where it adds | Orders on both sides, averaging in both directions | Adds only on the losing side to average the cost down (optionally one set per direction) |
| Exit condition | Each grid level takes profit independently | **Takes profit on the whole position at the current real average entry price** (can also be switched to per-entry exits) |
| Layers | Every grid level is placed up front | **Opens only the first entry, then adds one by one as price actually moves** |
| Capital | All of your capital sits in it | Each bot only touches the capital 「分配给它」 (allocated to it), and scales up only out of profits |

### Highlights

- **Zero third-party dependencies** — built-in Node.js modules only; you don't even need `npm install`. No supply-chain poisoning to worry about.
- **Ships with a web UI** — not a line of code to write, no config file to edit; everything is point-and-click in the browser.
- **Practice on paper first** — local virtual balance, local matching, no real money involved; change the balance and start over whenever you want.
- **Live trading is opt-in** — add an API key and it can reach a real account; it is **off** by default and must be explicitly switched on before a single real order goes out.
- **Every parameter is relative** — no hard-coded amounts anywhere in the code, so the same parameter set behaves exactly proportionally on a 100U and a 10,000U account.

---

## Who It's For, and Who It Isn't

### It's for you if...

- You want to learn quantitative trading **without first grinding through a pile of financial-engineering books** — there is a UI and a paper account, so a few clicks show you what the bot is doing.
- You already have hands-on experience with "add on dips, leave once you're back to even" and want to **automate** it.
- You want to read a **complete, runnable, dependency-free** Node codebase (about 11k lines, thoroughly commented).
- You want to use it as a **skeleton** for your own strategy (the strategy layer is pure functions, easy to swap out).

### It's not for you if...

- You are after "a steady 20% a month" — **no such thing exists**. See the risk disclosure below.
- You want high-frequency, millisecond-scale front-running — this is a low-to-mid frequency strategy that makes one decision every 5 seconds.
- You know nothing about futures and have no idea what "leverage" or "liquidation" mean — go read [docs/en/STRATEGY.md](docs/en/STRATEGY.md) first, or spend a week on the paper account.
- You want a "hosted service" — this is a tool you deploy on your own machine; there is no cloud and no shared account system.

---

## What the UI Looks Like

Once it is running, open `http://127.0.0.1:8787` in your browser and register a local account. There are 5 pages:

| Page | What you see / what you can do |
|---|---|
| **「登录 / 注册」 (Login / Register)** | Local account, passwords stored as salted hashes |
| **「概览」 (Overview)** | Account equity, today's P&L, running bots, order count, live market leaderboard, equity curve |
| **「机器人」 (Bots)** | Create (the parameter form is generated automatically), start, stop, reset, delete |
| **「机器人详情」 (Bot details)** | Plan preview (how many layers / how much per layer / long and short liquidation prices plus TP and SL), layer table, event log, order history, live preview while editing parameters |
| **「账户」 (Account)** | Paper / live equity, position details, **the paper balance can be changed at any time**, a notice when live trading is unavailable |
| **「API Key」 (API keys)** | Add, verify, delete; stored encrypted, and the page only ever displays a masked value |

---

## Up and Running in 3 Minutes

### Prerequisite: Install Node.js

You need **Node.js ≥ 22.5** (the project uses the built-in `node:sqlite` database); going straight to **Node 24 LTS** is recommended.

```bash
node -v     # must print v22.5.0 or newer
```

If you don't have it, download the LTS build from <https://nodejs.org/> and click Next through the installer.

### Start It

**Windows (PowerShell):**

```powershell
cd B:\biance_trae
node server.js
```

**macOS / Linux:**

```bash
cd /path/to/biance_trae
node server.js
```

Seeing output like this means it worked (the startup banner itself is in Chinese):

```bash
══════════════════════════════════════
  币安量化终端 · U 本位永续
══════════════════════════════════════
  数据目录：B:\biance_trae\data
  监听地址：127.0.0.1:8787
  部署前缀：（站点根路径）
  实盘下单：已关闭（安全闸，只读）
  [路由] 认证 已挂载
  [行情] 数据源：币安实时行情（fapi.binance.com）
```

> **No `npm install` needed** — this project has zero third-party dependencies.

### First Run

1. Open <http://127.0.0.1:8787> in your browser, click 「注册」 (Register), and enter any username and password (they exist only on your machine).
2. Go to the 「机器人」 (Bots) page → click 「新建机器人」 (New bot) → pick a symbol (say `BTCUSDT`) → set the mode to **模拟盘 (paper)**.
3. The default parameters are usable as they are; click 「创建」 (Create).
4. Back in the list, click 「启动」 (Start), then open the details page and you will see it going to work: event log, order history, equity changes.

> Want to change the paper-trading money? Go to the 「账户」 (Account) page and click the 「设置模拟余额」 (Set paper balance) button. That wallet is **shared by all paper bots**: opening a position reserves margin from it, closing a position returns the P&L and fees to it, and the bots never compete for the same funds.
> On top of that, each bot is capped by its own 「分配到的资金」 (Allocated capital), so they still don't fight over money.

### Change the Port or Allow LAN Access

```powershell
# Windows PowerShell
$env:PORT=9000; node server.js

# macOS / Linux
PORT=9000 node server.js
```

---

## How It Works

Every **5 seconds** (configurable) it runs one loop that does the following:

```
① Fetch quotes       Pull the latest price, ATR volatility and candles from Binance
      ↓
② Compute capital    Capital base = allocated capital + everything this bot has earned so far
      ↓
③ Build the plan     First-entry size, number of adds, size per layer, TP price, SL price
      ↓
④ Decide             Open the first entry now? Add? Take profit? Stop out? Or do nothing?
      ↓
⑤ Execute            Paper: book it locally    Live: send a real order to Binance
      ↓
⑥ Persist            Write orders, write events, record the equity curve
```

### Three Key Design Decisions

**1. Price anchor (`anchorPrice`)**
Once the plan is generated, the trigger prices for the adds are fixed and do not drift with the market.
Only after a **full close** does the bot take a new anchor and start a new round.

**2. The take-profit price is always computed from the "current real average entry price"**
`TP price = current average price × (1 + TP percentage)`

Why emphasize "current"? Because if you computed it from the "projected average after all 6 layers are filled", then while only 1 entry is open that projected average is still far below the market (for a long) and the current price is already above it — which means **the position takes profit the instant it opens** and you pay fees for nothing.
That was a real trap this project fell into early on; it now computes from current values.

**3. Layers means "how many adds you may make at most", not "how many you open up front"**
`maxLayers = 6` means: open 1 entry first, then add once every time price moves by the configured `间距` (spacing), up to 6 entries in total.
It does not open all 6 at once.

---

## Tuning the Parameters

All 13 parameters are labeled in Chinese and filled in directly on the form. The defaults are a deliberately "neutral" configuration:

| Parameter | Meaning | Default |
|---|---|---|
| 交易方向 (Direction) | Both directions / long only / short only | 双向 (both) |
| 分配给这个机器人的资金 (Capital allocated to this bot) | The most principal it may use (USDT) | 100 |
| 第一笔保证金占分配资金的比例 (First-entry margin as % of allocation) | What percentage of principal the 1st entry uses | 1% |
| 杠杆倍数 (Leverage) | Futures leverage | 20x |
| 每加一次仓，金额是上一次的几倍 (Add-on size multiplier) | Growth factor from one add to the next | 1.5 |
| 加仓间距 (Add spacing) | How far price must move from the average, in %, before adding | 1% |
| 最多加仓几次 (Max adds) | Layer cap | 6 |
| 单方向最多投入多少钱 (Max notional per direction) | Notional cap = allocated capital × this multiple | 3 |
| 全部加满时，最多能亏分配资金的百分之几 (Max loss budget) | Risk budget, as a % of allocated capital | 35% |
| 止盈方式 (Take-profit mode) | Whole-position TP at average / per-entry TP | 按均价 (at average) |
| 止盈幅度 (TP percentage) | How much % above the current average price to exit | 0.5% |
| 止损幅度 (SL percentage) | How much % below the current average price to accept the loss | 5% |
| 每多久判断一次 (Decision interval) | Decision cycle | 5 分钟 (5 minutes) |

### Three Reference Profiles

| | 保守 (Conservative) | 中性 / 默认 (Neutral, default) | 激进 (Aggressive) |
|---|---|---|---|
| 第一笔保证金占比 (First-entry margin share) | 0.5% | 1% | 2% |
| 杠杆 (Leverage) | 5x | 20x | 50x |
| 加仓间距 (Add spacing) | 2% | 1% | 0.5% |
| 最多加仓 (Max adds) | 4 次 (4) | 6 次 (6) | 10 次 (10) |
| 单方向名义上限 (Notional cap per direction) | 2 倍 (2×) | 3 倍 (3×) | 6 倍 (6×) |
| 最多亏损 (Max loss) | 20% | 35% | 50% |

> **The aggressive profile is not "more profit", it is "a faster road to zero".** Beginners should stick to the defaults and run the paper account for a full two weeks before even discussing tuning.

For what happens when each parameter goes up or down, see [docs/en/STRATEGY.md](docs/en/STRATEGY.md).

---

## Paper Trading vs. Live Trading

| | 模拟盘 (paper) | 实盘 (live) |
|---|---|---|
| Needs an API key | No | **Must** be added and verified first |
| Money | A local virtual balance, change it freely | Real money in your Binance account |
| Fills | Local matching, 0.05% fee + 0.02% slippage | Real market orders |
| Risk | Zero | **You will really lose money** |
| Purpose | Learn the UI, tune parameters, validate the logic | Only use it when you fully understand the consequences |

### Two Gates Before Going Live

1. **You must have a verified API key** — without one the bot refuses to start and shows a prompt in Chinese.
2. **You must set the environment variable `LIVE_TRADING=1` when starting** — otherwise a live bot is blocked even with a valid key: it only reads market data and places no orders.

```powershell
# Windows PowerShell
$env:LIVE_TRADING=1; node server.js

# macOS / Linux
LIVE_TRADING=1 node server.js
```

### The Bot Won't Close Positions You Opened Manually

Binance's hedge-mode positions are **aggregated at the account level** — the API only tells you "you have 4.37 contracts long on this symbol", and cannot tell which entries the bot opened and which you opened by hand.

This project's approach: every live bot keeps **its own position ledger**.

- Bot opens a position successfully → recorded in the ledger
- Every tick reconciles against the exchange's actual position
- Exchange quantity **greater than** the ledger → the excess is treated as a **manual position**, flagged, and **never closed** by the bot
- You close it manually on Binance → the ledger shrinks proportionally instead of trying to close a position that no longer exists

So manual positions and bot positions can coexist.

### When Creating a Live Bot, You Decide What to Do with Existing Positions

**This is a serious bug that 1.0.1 fixed**: early versions did not record which positions you already held, so every reconciliation round was a fresh guess. That produced two failure modes:

- The bot assumed everything on the exchange was yours → it only accounted for a small slice, leaving **a large position on the account and a tiny one for the bot**
- You manually closed everything → the bot's ledger was silently emptied → next round it thought "I have no position" and **opened another one**

Now, when you create a live bot and the symbol you picked already has a position, it checks once and shows a prompt:

| Option | Behaviour |
|---|---|
| **不保留，从零开始 (Don't keep it, start from zero)** (recommended) | The bot ignores your existing position entirely and only counts what it opens itself. You close your own position; the bot won't touch it |
| **保留为「手动仓」 (Keep it as a manual position)** | Registers the current position as a **baseline snapshot**. The bot then runs normally on its parameters but **never uses that position when computing add sizes, average price or take-profit price**. The top of the details page keeps showing 「手动仓基准 多 X / 空 Y 张（不参与计算）」 (Manual baseline: long X / short Y contracts, excluded from calculations) |

If you pick 「保留」 (Keep), the baseline is **re-snapshotted on first start** (time may pass between creating and actually starting the bot, and the position will have moved). If the bot already holds its own position, no re-snapshot happens — otherwise the bot's own position would be mistaken for a manual one.

Also, previously, when you manually closed a position that included the bot's share, the bot cleared its ledger **silently**; now it writes an explicit warning:

> 对账：多单在交易所已归零，但机器人账本里还有 1.234567 张。说明你手动把这个方向的仓（含机器人的部分）平掉了……
> *(Reconciliation: the long position is now zero on the exchange, but the bot's ledger still holds 1.234567 contracts. This means you manually closed the position in this direction, including the bot's share…)*

---

## Security Design

| Item | How it's done |
|---|---|
| API key storage | **AES-256-GCM encrypted** before it reaches the database; no endpoint ever returns plaintext, and the page only shows a masked value |
| Encryption master key | `data/master.key` (generated automatically, mode 0600); can also be supplied via the environment variable `BT_MASTER_KEY` |
| Login passwords | **scrypt + a random per-user salt**; verification uses `timingSafeEqual` to prevent timing attacks |
| Sessions | `HttpOnly; SameSite=Lax` cookie, 7-day expiry, revocable server-side |
| Login rate limiting | 5 attempts per minute for the same username |
| SQL | Every value is bound; no string concatenation |
| Authorization | Every write endpoint checks resource ownership, so user A cannot modify user B's bots |
| Network exposure | **Listens on `127.0.0.1` only** by default, not exposed externally |
| Live ordering | **Off by default**; only `LIVE_TRADING=1` unlocks it |
| Duplicate orders | Deterministic `clientOrderId`, so a resend after a network timeout is rejected by the exchange as a duplicate id |

> ⚠️ **If `data/master.key` is lost, the stored API keys can never be decrypted again.**
> When you back up `data/app.db` you **must back up `master.key` together with it**; backing up the database alone is as good as no backup at all.

For the full security policy, see [SECURITY.en.md](SECURITY.en.md).

---

## Risk Disclosure (Must Read)

This is a **real trading tool that loses real money**. Please read this section in full before you decide whether to go live.

1. **Futures is margin trading, and you can be liquidated.** At 20x leverage, a 5% adverse move can cost you your entire principal. The higher the leverage, the faster you reach zero.
2. **"Averaging down" gets carried all the way through a one-way market.** The core assumption of this strategy is that price will bounce.
   If a symbol enters a prolonged one-directional decline, adding only makes you **lose more, and faster**, until you run out of layers or hit the stop loss.
3. **The more aggressive the parameters, the faster you reach zero.** High leverage + tight spacing + many layers = a recipe for liquidation in a very short time.
4. **Fees are a continuous friction cost.** Every open and close pays a fee, so if the take-profit percentage is set too small (0.1%, say),
   fees will eat most of the profit or even put you at a net loss.
5. **Liquidation prices are estimates**; what the exchange returns is authoritative.
6. **This project is provided "as is" under Apache-2.0, with no warranty of any kind.** The author is not responsible for any financial loss caused by using this project.

**If you intend to go live, follow this order:**

1. Run the paper account for **at least two weeks** and confirm that you personally accept the logic and the parameters.
2. Start live with **a very small amount you can afford to lose entirely**, and run it for a week.
3. Give the API key **futures-trading permission only — absolutely never withdrawal permission**, and bind an IP whitelist if you can.
4. Check the account once a day and confirm the bot is behaving as expected.
5. If anything feels wrong at any point, **stop the bot first**, then analyze.

---

## Documentation

| Document | Content |
|---|---|
| [docs/en/QUICKSTART.md](docs/en/QUICKSTART.md) | A hand-held, screenshot-style walkthrough: from installing Node to your first working bot |
| [docs/en/STRATEGY.md](docs/en/STRATEGY.md) | The strategy in depth: the 13 parameters, the add-on math, take profit and stop loss, risk |
| [docs/en/FAQ.md](docs/en/FAQ.md) | Common questions: installation, usage, live-trading errors, security, deployment |
| [docs/en/ARCHITECTURE.md](docs/en/ARCHITECTURE.md) | Code architecture and reading guide: start here to change code or add a strategy |
| [DEPLOY.en.md](DEPLOY.en.md) | Deploying to a Linux server: systemd service, Nginx reverse proxy, HTTPS, backups |
| [SECURITY.en.md](SECURITY.en.md) | Security policy and how to report a vulnerability |
| [CONTRIBUTING.en.md](CONTRIBUTING.en.md) | Contribution guide: code style, tests, opening a PR |

---

## Project Structure

```
biance_trae/
├── server.js                  Entry point: wires up routes, starts the server, restores previous bots
├── package.json               No third-party deps; just the start / check scripts
├── README.md                  The file you are reading
├── DEPLOY.md                  Server deployment manual
├── CONTRIBUTING.md / SECURITY.md
├── docs/                      In-depth documentation
├── data/                      Created automatically at runtime (database + master key, not in git)
│   ├── app.db                 SQLite database
│   └── master.key             Master key for API key encryption (be sure to back it up)
├── scripts/                   Self-check scripts + unit tests
│   ├── check.js               Syntax check for every JS file
│   └── test-*.mjs             6 unit test suites (node --test)
└── src/
    ├── config.js              Global config / environment variables
    ├── db.js                  SQLite access layer
    ├── crypto.js              AES-256-GCM / scrypt / HMAC
    ├── http.js                Minimal HTTP framework (routing / body / cookie / static hosting)
    ├── auth.js                Sessions and accounts
    ├── routers/               5 HTTP route modules
    │   ├── auth.js            Register / login / metadata
    │   ├── robots.js          Bot CRUD / preview / start-stop / reset
    │   ├── market.js          Market data
    │   ├── account.js         Account and paper-trading wallet
    │   └── apikeys.js         API key management
    ├── binance/               Exchange adapter layer
    │   ├── rest.js            Binance REST client (signing / timeouts / clock sync)
    │   ├── live.js            Live order placement
    │   ├── paper.js           Paper-trading matching
    │   ├── liveMarket.js      Live market data
    │   ├── mockMarket.js      Offline simulated market data
    │   └── index.js           Unified entry point
    ├── strategy/              Strategy layer (the core)
    │   ├── params.js          Parameter definitions and validation
    │   ├── solver.js          Math solving (pure functions, no IO)
    │   ├── engine.js          Decision state machine
    │   ├── runner.js          Tick loop and persistence
    │   ├── wallet.js          Shared paper-trading wallet
    │   ├── liveBook.js        Live position ledger
    │   └── protect.js         Take-profit / stop-loss conditional orders
    └── static/                Front-end single-page app (vanilla JS, no framework)
        ├── index.html
        ├── app.js
        └── styles.css
```

Size: roughly **11k lines** of code / 36 files / 28 HTTP endpoints.

---

## FAQ

**Q: Do I need to run `npm install`?**
No. Zero third-party dependencies — built-in Node modules only.

**Q: How new does Node have to be? Why does anything below 22.5 fail?**
The project uses `node:sqlite` as its database, and that module only became available in **Node 22.5**. Anything older errors out immediately on startup.

**Q: Can I put it on the public internet and reach it from my phone?**
Yes, but it **must sit behind an HTTPS reverse proxy**, and do not expose the port directly to the internet.
See [DEPLOY.en.md](DEPLOY.en.md) for details.

**Q: Are the paper-trading prices real?**
Yes. By default it pulls live market data straight from Binance at `fapi.binance.com`. Only when your network cannot reach Binance does it automatically fall back to locally simulated prices, with a notice in the UI.

**Q: Why do I get 「参数不可行」 (Parameters not feasible) when creating a bot?**
Usually because the first-entry amount — 「分配资金」 (Allocated capital) × first-entry share × leverage — comes out too small and falls below the exchange's minimum order size.
The message tells you directly which parameter to raise and to what value. See [docs/en/FAQ.md](docs/en/FAQ.md).

**Q: The bot never does anything?**
That's normal. It is waiting for price to reach the planned level. Open the 「详情」 (Details) page and read the event log to see how it judged every step.

More questions in [docs/en/FAQ.md](docs/en/FAQ.md).

---

## Contributing

Issues and PRs are welcome. Please read [CONTRIBUTING.en.md](CONTRIBUTING.en.md) before you start.

Before submitting code, make sure both of these pass:

```bash
node scripts/check.js        # syntax check for every file
node --test scripts/*.mjs    # unit tests all green
```

---

## License

[Apache License 2.0](LICENSE) © MikuYun

> **Disclaimer**: This project is for learning and technical research only. Digital-asset futures trading carries extremely high risk and can result in the total loss of your principal.
> By using this project you acknowledge that you understand and accept all of that risk yourself; the author accepts no liability for any financial loss. Please comply with the laws and regulations of your jurisdiction.
