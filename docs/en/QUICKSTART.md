**English** ｜ [中文](../QUICKSTART.md) ｜ [日本語](../ja/QUICKSTART.md)

# Quick Start

From zero to your first running paper-trading bot in about **5 minutes**. Just follow along — no coding knowledge needed.

> Works on Windows / macOS / Linux. Any screenshot positions are only illustrative; the actual interface is whatever you see.

---

## Contents

- [Step 1: Install Node.js](#step-1-install-nodejs)
- [Step 2: Start the service](#step-2-start-the-service)
- [Step 3: Register an account](#step-3-register-an-account)
- [Step 4: Set the paper-trading wallet balance](#step-4-set-the-paper-trading-wallet-balance)
- [Step 5: Create your first bot](#step-5-create-your-first-bot)
- [Step 6: Start it and watch](#step-6-start-it-and-watch)
- [Step 7: Read the detail page](#step-7-read-the-detail-page)
- [Common stumbling blocks](#common-stumbling-blocks)
- [Next steps](#next-steps)

---

## Step 1: Install Node.js

### Check whether it is already installed

Open a terminal (**PowerShell** on Windows, 「终端」 (Terminal) on macOS) and type:

```bash
node -v
```

- It prints `v22.5.0` or a higher version → **it is already installed, skip to Step 2**.
- It prints `v18.x` / `v20.x` → the version is too low and needs upgrading (this project uses the built-in database module that only arrived with Node 22.5).
- It says 「找不到命令」 (command not found) → it is not installed yet.

### Not installed / version too low

1. Open <https://nodejs.org/>
2. Download the **LTS** release (currently the 22 or 24 line)
3. Click 「下一步」 (Next) all the way through the installer
4. **Close the terminal and open it again** (important, otherwise the environment variables will not take effect)
5. Run `node -v` once more to confirm

> On Windows you can also use winget: `winget install OpenJS.NodeJS.LTS`
> On macOS you can also use Homebrew: `brew install node`

---

## Step 2: Start the service

Go into the project directory and run the entry file.

**Windows PowerShell:**

```powershell
cd B:\biance_trae
node server.js
```

**macOS / Linux:**

```bash
cd /你的路径/biance_trae
node server.js
```

**Output like this means it worked:**

```
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

On first start it automatically creates two things under the `data/` directory:

| File | Purpose |
|---|---|
| `data/app.db` | SQLite database holding accounts, bots, orders and events |
| `data/master.key` | Master key that encrypts API keys (generated automatically, permissions 0600) |

> ⚠️ **You must back up `data/master.key`.** If it is lost, the API keys already stored in the database can never be decrypted again.

**You do not need `npm install`** — this project has zero third-party dependencies.

> This terminal window *is* the server process: **close it and the service stops**. To keep it running permanently, see
> the systemd section in [DEPLOY.en.md](../../DEPLOY.en.md).

---

## Step 3: Register an account

Open this in your browser:

```
http://127.0.0.1:8787
```

The first visit shows the login page. Click the **「注册」** (Register) tab at the top:

| Field | What to enter |
|---|---|
| 用户名 (Username) | Make up your own: 3–32 letters, digits or underscores (e.g. `miku`) |
| 密码 (Password) | At least 6 characters (a strong password you cannot memorise is fine, as long as you can look it up) |

Click 「注册并登录」 (Register and sign in).

> This is a **purely local account**. It lives only in `data/app.db` on this machine, is never uploaded anywhere,
> and needs no email address or phone number. If you forget the password you can only edit the database by hand (see the FAQ).

After signing in you land on the 「概览」 (Overview) page. The top navigation has 4 items: **概览 (Overview) / 机器人 (Bots) / 账户 (Account) / API Key**.

---

## Step 4: Set the paper-trading wallet balance

Before starting a bot for real, put some money in the paper-trading wallet.

1. Click **「账户」** (Account) in the top navigation
2. Click **「设置模拟余额」** (Set paper balance) in the top right
3. Enter an amount (default 100, minimum 10 USDT)
4. Leave 「处理方式」 (Handling method) on the default **「重置钱包，并清空所有机器人的持仓」** (Reset the wallet and clear all bot positions)
5. Click 「保存」 (Save)

There are three things to understand clearly about this wallet:

- It is **account-level**: think of it as the wallet balance of a Binance unified (cross-margin) account. **All paper bots share this one wallet**.
- When a bot opens a position it **reserves** margin from the wallet; when it closes, the P&L and fees are **returned** to the wallet.
- Each bot also has a limit of its own: it may only draw on 「分配给这个机器人的资金」 (the capital allocated to that bot).
  That way running three bots will not bet the same money three times over.

> You can change the wallet at any time, even when no bot exists yet.

---

## Step 5: Create your first bot

Click **「机器人」** (Bots) in the top navigation → **「+ 新建机器人」** (+ New bot) in the top right.

The dialog asks for four kinds of things:

### ① Bot name

Anything you like, e.g. `BTC 稳健型` (BTC steady). It is just a label for your own reference.

### ② Trading instrument

The dropdown lists the highest-turnover instruments in Binance USDⓈ-M perpetual futures, sorted by turnover.
Beginners should pick **`BTCUSDT`** or **`ETHUSDT`** first (best liquidity, smallest slippage).

### ③ Run mode

| Option | Description |
|---|---|
| 模拟模式（不联网，本地模拟成交） (Paper mode — offline, locally simulated fills) | **Beginners pick this.** Virtual funds, local matching, zero risk |
| 实盘模式（调用币安真实接口） (Live mode — calls the real Binance API) | Real money. You must configure the keys on the API Key page first |

**Always choose paper mode the first time.**

### ④ Strategy parameters

The form is generated automatically from the parameter definitions, 13 items in total. On your first run **just keep the defaults**:

| Parameter | Default |
|---|---|
| 交易方向 (Trading direction) | 双向 (Dual) |
| 分配给这个机器人的资金 (Capital allocated to this bot) | 100 USDT |
| 第一笔保证金占分配资金的比例 (First order's margin as a share of allocated capital) | 1% |
| 杠杆倍数 (Leverage) | 20 |
| 每加一次仓，金额是上一次的几倍 (Each add-on is how many times the previous one) | 1.5 |
| 加仓间距 (Add-on spacing) | 1% |
| 最多加仓几次 (Maximum number of add-ons) | 6 |
| 单方向最多投入多少钱 (Maximum committed per direction) | 3 倍 (3×) |
| 全部加满时，最多能亏分配资金的百分之几 (Worst-case loss as a share of allocated capital when fully stacked) | 35% |
| 止盈方式 (Take-profit mode) | 按均价 (By average price) |
| 止盈幅度 (Take-profit band) | 0.5% |
| 止损幅度 (Stop-loss band) | 5% |
| 每多久判断一次 (Decision interval) | 5 分钟 (5 minutes) |

Below the form, a **「计划预览」** (Plan preview) appears automatically, telling you how this parameter set works out:

- The first order's notional value and margin
- The trigger price of every add-on
- The average price, take-profit price and stop-loss price after each add-on
- The liquidation price on the long and the short side separately
- The maximum loss when fully stacked

If the parameter combination cannot produce a viable plan (for example the first order is too small to be placed), a red warning appears right here,
telling you **which parameter to move to what value**. The preview refreshes live while you edit.

When it all looks right, click **「创建」** (Create).

---

## Step 6: Start it and watch

Back on the bot list, find the bot you just created and click **「启动」** (Start).

After starting:

- The status on the card becomes **运行中** (Running)
- It makes a decision roughly every 5 seconds
- The equity curve starts to have data

Open the detail page (click the bot card) to see what is happening live.

---

## Step 7: Read the detail page

The detail page has four blocks, top to bottom:

### ① Top KPIs

| Metric | Meaning |
|---|---|
| 当前权益 (Current equity) | Allocated capital + unrealised P&L + realised P&L |
| 浮动盈亏 (Unrealised P&L) | P&L on positions that are still open |
| 已实现盈亏 (Realised P&L) | P&L already closed out and banked |
| 已建仓笔数 / 上限 (Layers opened / limit) | Which layer you are on now / how many are allowed |

### ② Plan preview + layer table

The layer table shows, for each layer:

| Column | Meaning |
|---|---|
| 第几笔 (Layer number) | 1 is the one opened right now, 2 is the first add-on, and so on |
| 这笔名义 (Notional of this layer) | How big this layer is (notional = margin × leverage) |
| 保证金 (Margin) | How much money this layer reserves |
| 价格跌到这里才加(多) (Long add-on triggers only when price falls here) | **The trigger price — the layer is added only if price really gets here; it is not opened now** |
| 加完后的多单均价 (Long average price after this layer) | What the average cost of the position becomes once this layer is added |
| 加完后的多单止盈 (Long take-profit after this layer) | After this layer, a bounce to this price takes profit |
| 加完后的多单止损 (Long stop-loss after this layer) | After this layer, a fall to this price accepts the loss |

Layers already opened carry an **「已建」** (Opened) badge. Dual mode shows both a long table and a short table.

> **Key point**: `最多加仓 6 次` (max 6 add-ons) does not mean 6 layers are open now.
> Only layer 1 exists now; the remaining 5 are "actions that happen only if price reaches their trigger".

### ③ Event log / order history

- **事件日志** (Event log): every judgement the bot makes, e.g. 「开多 第 1 笔：名义 20.00U，保证金 1.00U」 (Open long layer 1: notional 20.00U, margin 1.00U),
  「平空：止盈（单层目标 81.29），盈亏 +8.05U」 (Close short: take-profit, single-layer target 81.29, P&L +8.05U), 「开仓被拒：账户可用余额不足……」 (Order rejected: insufficient available balance…).
  If you want to know "why is the bot not moving", look here.
- **订单流水** (Order history): every fill that actually happened, with quantity, price and fee.

### ④ Parameter editing

You can edit parameters directly at the bottom of the detail page; there is a live preview while you edit, and 「保存参数」 (Save parameters) applies them.
**A running bot cannot have its parameters changed** — click 「停止」 (Stop) first.

---

## Common stumbling blocks

### 「参数不可行 / 最小可下单金额」 (Parameters not viable / minimum order amount)

**Cause**: `分配资金 × 第一笔占比 × 杠杆` (allocated capital × first-order share × leverage) works out to a first order that is too small — below the smallest order the exchange accepts.

Binance has two thresholds:

1. Notional value per order **≥ 5 USDT**
2. Quantity must be a multiple of `stepSize` and **≥ `minQty`**

The second one is sneakier. For example, an instrument priced at 976 with `minQty = 0.01`:
the smallest clip, 0.01, is worth **9.76 USDT** — so even if you write 6 USDT as the notional, the order will not go through.

The platform uses:

```
最小可下单金额 = max(minNotional, ceil(minQty / stepSize) × stepSize × 现价)
```

**What to do**: the error message itself computes how far you need to raise 「分配资金」 (Allocated capital) or
「第一笔保证金占比」 (first-order margin share). Just follow it.

### 「机器人一直不动」 (The bot never moves)

**This is usually normal.** It is waiting for price to reach the levels in the plan.

Check the 「事件日志」 (Event log) on the detail page. If the last entry is a 「建首层」 (open first layer) from long ago, or nothing was written at all,
price has not triggered an add-on and has not reached take-profit or stop-loss.

If the log says 「开仓被拒：账户可用余额不足」 (Order rejected: insufficient available balance), the wallet has been fully reserved by other bots —
check 「可用余额」 (Available balance) on the account page.

### 「行情显示不出来 / 价格不跳」 (Market data will not show / price is frozen)

**Cause**: your network cannot reach Binance's `fapi.binance.com` (common in mainland China).

The platform automatically degrades to locally simulated prices and says so explicitly on the page with 「降级」 (degraded). It is designed not to crash.

**What to do**: put a proxy in front of the machine, or deploy the service to a server that can reach Binance (see [DEPLOY.en.md](../../DEPLOY.en.md)).

### 「打不开 8787 端口」 (Port 8787 will not open)

**Cause**: another program is already using the port.

**What to do**: start on a different port:

```powershell
# Windows PowerShell
$env:PORT=9000; node server.js
```

```bash
# macOS / Linux
PORT=9000 node server.js
```

Then visit `http://127.0.0.1:9000`.

---

## Next steps

Once paper trading works, continue in this order:

1. **Tune parameters** — read [STRATEGY.md](STRATEGY.md), understand what each of the 13 parameters affects, then try the three reference presets.
2. **Paper-trade for at least two weeks** — including a stretch of one-way decline, so you feel what being underwater on add-ons is like.
3. **Understand take-profit and stop-loss** — the 「计划预览」 (Plan preview) on the detail page shows where each layer's take-profit and stop-loss prices come from.
4. **Only then consider live trading** — read the live-trading chapter of [FAQ.md](FAQ.md) and configure an API key (**enable futures trading permission only, never enable withdrawals**),
   then run with a very small amount for a week.
5. **To deploy on a server** — read [DEPLOY.en.md](../../DEPLOY.en.md): systemd for persistence + Nginx reverse proxy + HTTPS.

> One more time: **futures trading is extremely risky and can wipe out your capital.** How much you make in paper mode says nothing about live results.
