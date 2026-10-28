**English** ｜ [中文](../STRATEGY.md) ｜ [日本語](../ja/STRATEGY.md)

# How the Strategy Works, in Detail

> This document explains in plain words **what this bot is actually doing, why it does it that way, and when it loses money**.
> You need no quant background and no coding skills. Every number in here comes from the program's real calculations — none are made up as illustrations.

## I. What this bot does, in one sentence

Imagine going to the market to buy potatoes.

You do not know whether potatoes will be cheaper today, so you **do not spend all your money at once**: you buy a small bag to try. If the price falls again and looks like a bargain, you buy another bag; it falls again, you buy a third — buying more the further it falls, which pulls your average cost down. Then when price bounces back above your average cost and you are a little in profit, you sell every potato you hold and walk away.

**That is what going long means here: split the buying into several steps as price falls to average down, then leave as soon as you are back in profit.**

**Going short is the same thing upside down**: you sell in several steps as price rises (selling borrowed coins), you profit when price falls back, and when it drops below your average price you buy it all back and close.

Put into one sentence:

> **Do not predict direction. Only add in tranches at fixed spacing while price moves against you, diluting your average entry price; and as soon as price comes back a little above (or a little below) your actual average holding price, close everything at once and bank it.**

So this strategy does not earn money from "calling the direction right", it earns **the money of "oscillation"** — as price swings up and down inside a range, it repeatedly harvests that small bounce.

| Market type | How this strategy behaves |
| --- | --- |
| Oscillating back and forth (no break out of the range) | Comfortable, takes profit over and over |
| One-way crash (long-only) | Dangerous: adds all the way down, ends in a stop-loss or liquidation |
| One-way surge (long-only) | Cannot open a satisfying position, or opens one and takes profit immediately — makes little, but does not lose much |
| Long sideways drift | Neither wins nor loses, only bleeds a little in fees |

## II. A few words first

These words come up constantly below, so they are explained the first time they appear:

| Word | Plain-language explanation |
| --- | --- |
| Contract / perpetual contract | Trading that lets you go long or short without actually holding the coin; "perpetual" means it has no expiry date, so you can hold it indefinitely |
| Position | The number of contracts you currently hold |
| Notional value (notional) | What your position is worth in money at the current price. For example 0.02 coins at a price of 1000 gives a notional of 20 USDT |
| Margin | The money actually pledged in your account. Notional ÷ leverage |
| Leverage | The multiplier. 20× leverage = pledge 1 to open a position worth 20 |
| Average price (average entry price) | The average cost of several purchases. Buy in 3 tranches at different prices and you get one averaged cost |
| Add-on / adding a layer | You already hold a position and price moves further against you, so you add another tranche |
| Take-profit / stop-loss | Closing voluntarily while in profit (take-profit); accepting a loss and closing once it reaches a preset level (stop-loss) |
| Liquidation (blowing up) | Losses eat the margin and the exchange forcibly closes you out. **Catastrophic — it must be avoided by the stop-loss** |
| Slippage / fees | The small gap between order price and fill price (slippage); the toll charged on every fill, once on entry and once on exit (fees) |
| tick | Every few seconds the bot wakes up and checks whether it should act; one such wake-up is one tick |

## III. How the long and short legs are laid out

When the `交易方向` (Trading direction) parameter is set to **双向 (dual)**, the bot places **two completely independent bots on the same instrument at the same time**:

| | Long leg | Short leg |
| --- | --- | --- |
| When the first tranche opens | Opens long immediately at market price | Opens short immediately at market price |
| When it adds | Price **falls** to the add-on line | Price **rises** to the add-on line |
| How the add-on line is computed | Actual average price × (1 − spacing%) | Actual average price × (1 + spacing%) |
| When it takes profit | Price rises to actual average price × (1 + take-profit%) | Price falls to actual average price × (1 − take-profit%) |
| When it stops out | Price falls to actual average price × (1 − stop-loss%) | Price rises to actual average price × (1 + stop-loss%) |
| Direction of liquidation | Price moves too far **down** | Price moves too far **up** |

**The two legs use exactly the same parameters and mirror each other's logic, but keep separate books, take-profit prices, stop-loss prices, liquidation prices and add-on progress.**

That means: while one leg is underwater, the other may well be making money. If price falls to 950, the long leg may already be 4 layers deep at a floating loss, while the short leg probably banked its profit long ago.

Why dual by default? Because **the strategy itself does not predict direction**. If you only go long, a one-way crash leaves you watching helplessly as add-ons get deeper and deeper. Dual is a way of saying "I don't care which way you run — I set up stalls on both sides and wait for oscillation". The cost: double the fees, double the margin reserved, and if the oscillation is too small both sides may get ground down.

The `交易方向` (Trading direction) parameter can also be changed to long-only or short-only, in which case there is only one leg.

> **Note**: to hold long and short at the same time, the Binance account must be in 「双向持仓模式」 (hedge mode). You have to switch that on yourself on the Binance website or app; the program will not change it for you.

## IV. The 13 parameters, one by one

The parameter names are the Chinese labels shown on the page; the internal names in the code appear in parentheses (you will meet them when reading code or logs).

### 4.1 The four basics

| Parameter (internal name) | Default | Plain language | If you raise it | If you lower it |
| --- | --- | --- | --- | --- |
| **交易方向 (Trading direction)** (`direction`) | 双向 (dual) | How many legs, and which way they point. Dual = long and short at once; long-only = only adds when price falls; short-only = only adds when price rises | Single → dual doubles your risk exposure | Dual → single bets on one side only |
| **分配给这个机器人的资金（USDT）(Capital allocated to this bot, USDT)** (`allocatedCapital`) | 100 | How much money this bot is "nominally" allowed to use. It is not transferred out of the account, it is just a bookkeeping cap | Bigger tranches, more layers, bigger losses too | Smaller tranches, until it may be too small to open even one |
| **第一笔保证金占分配资金的比例（%）(First order's margin as a share of allocated capital, %)** (`firstPct`) | 1 | What percentage of the allocated capital the first tranche pledges. 1% × 100U = 1U of margin | A heavier first tranche leaves less room to add and loses faster | A lighter first tranche allows more layers, but if a tranche gets too small it hits the minimum order size |
| **杠杆倍数 (Leverage)** (`leverage`) | 20 | The multiplier. 1U of margin × 20 = a position with 20U notional | The same margin opens a bigger position; profit and loss scale together and liquidation gets closer | The same margin opens a smaller position and liquidation gets further away, but clearing the minimum order size gets harder |

### 4.2 The four add-on parameters

| Parameter (internal name) | Default | Plain language | If you raise it | If you lower it |
| --- | --- | --- | --- | --- |
| **每加一次仓，金额是上一次的几倍 (Each add-on is how many times the previous one)** (`growRatio`) | 1.5 | Tranche 2 is 1.5× tranche 1, tranche 3 is 1.5× tranche 2… like a snowball | The later tranches become very concentrated and pull the average down fast, but a reversal hurts badly (warns above 2) | At 1 every add-on is the same size; the average moves slowly but evenly |
| **加仓间距（%）(Add-on spacing, %)** (`spacingPct`) | 1 | Price must move another 1% away from the average before the next tranche is added. Wider spacing means "lazier" | Fewer add-ons, price must fall further to trigger, fewer layers get trapped, but bounces may be missed | Denser add-ons; the average tracks price closely, but fees pile up and layers are used up fast |
| **最多加仓几次（层数上限）(Maximum number of add-ons, layer cap)** (`maxLayers`) | 6 | The maximum number of tranches. Note: this is a *cap*; how many layers you actually get is computed by risk control (see the next section) | Can absorb a deeper decline, but reserved margin and worst-case loss both rise | Fewer layers, cannot absorb a deep decline, fills up quickly |
| **单方向最多投入多少钱（分配资金的几倍）(Maximum committed per direction, in multiples of allocated capital)** (`totalPct`) | 3 | The total notional of all layers on one side may not exceed "allocated capital × 3". 100U allocated → 300U notional cap | Allows a larger total position | Total position is squeezed, and even the first tranche may fail validation |

> **Important**: `层数上限` (the layer cap) is only "how many you want"; **how many you actually get is computed**. With the defaults you ask for 6 layers and get only 5 — because a 6th would push total notional or worst-case loss past `单方向总投入上限` (the per-direction cap) or `最大亏损占比` (the maximum loss share). The system trims it automatically and writes the reason into the event log.

### 4.3 Risk control plus take-profit and stop-loss: three parameters

| Parameter (internal name) | Default | Plain language | If you raise it | If you lower it |
| --- | --- | --- | --- | --- |
| **全部加满时，最多能亏分配资金的百分之几 (Worst-case loss as a share of allocated capital when fully stacked, %)** (`maxLossPct`) | 35 | A hard ceiling: having stacked every layer, running all the way to the stop-loss may lose at most 35% of the allocated capital | Allows a bigger worst case and therefore more layers | Layers get trimmed and you cannot fill up |
| **止盈方式 (Take-profit mode)** (`tpMode`) | 整体止盈 (whole-position) | Whole-position = close everything together at the average price of the entire position; per-layer = each tranche exits on its own once it reaches its price | — | — |
| **止盈幅度（%）(Take-profit band, %)** (`tpPct`) | 0.5 | Price must be 0.5% above the average before closing | More per trade, but harder to reach and the stop-loss may trigger first | Fills more easily, but the profit may not even cover the fees (warns below 0.3%) |
| **止损幅度（%）(Stop-loss band, %)** (`stopPct`) | 5 | If price moves 5% against the average, accept the loss and close everything | Absorbs more, but each loss is bigger | Cuts losses faster, but ordinary noise sweeps you out (warns when it is not larger than the add-on spacing) |

### 4.4 The one pacing parameter

| Parameter (internal name) | Default | Plain language | Notes |
| --- | --- | --- | --- |
| **每多久判断一次 (Decision interval)** (`interval`) | 5m | Which candlestick interval is used to estimate volatility (ATR: 1m / 5m / 15m / 1h). It only affects the 「波动率」 (volatility) reference shown on the page and **does not participate in any buy/sell calculation**. What really decides when to act is the price check (tick) every 5 seconds | Longer intervals give a smoother volatility estimate; shorter intervals are more sensitive. Changing it never changes when an order is placed |

### 4.5 Checks performed when saving parameters

**Three hard errors** (saving is refused outright and the page reports 「参数不可行」 (parameters not viable)):

1. **First tranche too small**: the first tranche's notional value is below the minimum order amount for this instrument.
2. **First tranche too heavy**: the first tranche's notional takes more than 400% of the allocated capital (e.g. 20% × 20× = 400%).
3. **First tranche already over budget**: the first tranche's notional exceeds 「单方向总投入上限」 (the per-direction cap).

**Three warnings** (they do not block you, but they do alert you): the take-profit band is so small that fees eat it; the stop-loss band is not wider than the add-on spacing; the add-on multiplier is so large that the later tranches become overly concentrated.

## V. One full round trip, from opening to closing (real numbers)

Take the defaults: allocated **100 USDT**, first tranche **1%**, leverage **20×**, add-on multiplier **1.5**, spacing **1%**, at most **6 layers**, total commitment **3×**, maximum loss **35%**, whole-position take-profit **0.5%**, stop-loss **5%**, dual mode. Assume the current price is 1000.

First, the **plan the program computes** (long side only; the short side is an exact mirror, and these numbers are real):

| Tranche | Trigger price | Notional | Margin | Average price afterwards |
| --- | --- | --- | --- | --- |
| Tranche 1 | 1000 (opened right now) | 20 U | 1.00 U | 1000.00 |
| Tranche 2 | 990.00 | 30 U | 1.50 U | 993.98 |
| Tranche 3 | 980.10 | 45 U | 2.25 U | 987.35 |
| Tranche 4 | 970.30 | 67.5 U | 3.375 U | 980.20 |
| Tranche 5 | 960.60 | 101.25 U | 5.06 U | 972.58 |

> You set 6 layers, the program gave you 5. The event log says so explicitly: **「层数从 6 自动降到 5：再多加就突破风险上限了（总仓位或最大亏损）」** (layers reduced from 6 to 5: one more add-on would breach the risk cap — total position or maximum loss).
>
> This table is a **plan**: the trigger prices are laid out downwards from "the price at the moment the bot was created" and do not drift with the market. Real runs differ slightly — each add-on uses "**the current actual average holding price** × (1 − spacing%)", and because fills include slippage the real average is a bit higher, so the add-on line sits a bit higher too. The story below is written from the real calculations.

Here is what actually happens (slippage and fees are computed by the program's model: fees 0.05%, slippage 0.02%):

1. **First tick**: price 1000. No position, so tranche 1 opens — 20 U notional, 1 U of margin, 20× leverage. The actual fill is 1000.2 (0.02% of slippage paid on the buy), buying 0.019996 coins. **The bot now waits for one of two things: a fall to 990.20 to add, or a rise to 1005.20 to take profit.**
2. **Price falls to 990.20**: this is the "add-on line" = actual average 1000.2 × (1 − 1%). Tranche 2 opens, 30 U notional, 1.5 U of margin. Fill at 990.40. The position becomes 0.050287 coins and the average is diluted to **994.29**.
3. **Price keeps falling to 984.35**: add-on line = 994.29 × (1 − 1%). Tranche 3 opens, 45 U notional, 2.25 U of margin. Fill at 984.55. The position is 0.095993 coins, the average is diluted to **989.65**, total notional 95 U, margin reserved 4.75 U.
4. **Price bounces**: it climbs all the way back from 984. On every tick the bot recomputes: **"current actual average 989.65 × (1 + 0.5%) = 994.6022 — when we get there, close everything."**
5. **Price reaches 994.61**: take-profit is hit. **All 3 tranches are closed in one go**, filled at 994.40 (slippage takes another bite on the sell).
6. **Settlement**: gross profit +0.456 U, the two fees together −0.095 U, so **net profit +0.361 U** (that is **0.36%** of the 100 U allocated capital).
7. **Back to the start**: the position is flat and the bot waits for the next entry. Price is still around 994, so on the next tick it immediately opens a fresh tranche 1 near 994.

**Two things in this example deserve the most attention:**

- The table says "take profit 0.5%", yet the actual net gain is only **0.36%** — fees ate almost a third of it. This is why the take-profit band must not be set too small.
- If, after falling to 984, price **never comes back** but keeps falling to **932.78** (5% below the 981.87 average once all 5 layers are stacked), the stop-loss triggers and you lose **−13.50 U in one go**, which is **13.5%** of the allocated capital. Gaining 0.36% and losing 13.5%: that asymmetry has to be understood before you start.

## VI. The capital base rolls: why it is "allocated capital + realised P&L"

This is the most commonly misunderstood part of the whole design.

The 「分配资金」 (allocated capital) on the page **is not money transferred out of the account**; it is only a "budget cap". What actually drives order size is an intermediate quantity called the **capital base**:

```
资金基数 = 分配给这个机器人的资金 + 这个机器人累计已实现盈亏
```

| Stage | Allocated capital | This bot's cumulative realised P&L | Capital base | First tranche margin (1%) | First tranche notional (×20) |
| --- | --- | --- | --- | --- | --- |
| Just created | 100 U | 0 | **100 U** | 1 U | 20 U |
| After making 20 U | 100 U | +20 U | **120 U** | 1.2 U | 24 U |
| After losing 96 U | 100 U | −96 U | **24 U** | 0.24 U | 4.8 U (**cannot be opened any more**) |

### Why design it this way?

Because **a Binance account aggregates at account level**. In that one account you may be running 5 bots and also opening positions by hand. If every bot computed its first tranche from "total account equity", the same money would be allocated 5 times over — the account holds 1000 U, yet 5 bots each believe they have 1000 U to lose, and the first one to start losing sets off a chain of liquidations.

So each bot only counts **its own budget** (allocated capital) plus **what it itself has made or lost** (realised P&L). Other bots' results are irrelevant to it.

### Why shrink when losing and grow when winning?

- **Grow when winning**: compound interest. 100 → 120, and the same 1% first tranche becomes 1.2 U. The more you make, the bigger each tranche, and that is compounding.
- **Shrink when losing**: this is the survival mechanism. After losing 96 U the base is only 24 U, so the first tranche of 4.8 U is already below Binance's 5 U minimum order size. The program immediately judges it "not viable" and stops acting, writing in the log:

> 第一笔金额太小：名义 4.80U，低于该标的的最小可下单金额 5.00U。把「第一笔保证金占分配资金的比例」调到 1.05% 以上，或把「分配给这个机器人的资金」调到 25U 以上，或提高杠杆。 (First tranche too small: notional 4.80U, below this instrument's minimum order amount of 5.00U. Raise the first-order margin share above 1.05%, or raise the capital allocated to this bot above 25U, or increase leverage.)

In other words, **once losses push the bot past the point where it "cannot punch any more", it stops by itself** instead of gambling with the last of the money. To restart it, either give it more allocated capital or raise the first-tranche share.

## VII. The two take-profit modes, and one very important trap

### 7.1 Comparing the two modes

| | Whole-position take-profit (`avg`) | Per-layer take-profit (`layer`) |
| --- | --- | --- |
| Basis for the decision | **The current actual average price of the entire position** | Each tranche's **own entry price** |
| How much is closed | Everything at once | Only the tranches that have reached their price; the rest stay untouched |
| Example (average 989.65 after 3 tranches) | Rising to 989.65 × 1.005 = **994.60** closes everything | Tranche 1 entered at 1000.2 → closes at 1005.20; tranche 2 entered at 990.40 → closes at 995.35; tranche 3 entered at 984.55 → closes at 989.47 |
| Advantage | One clean exit, one set of closing costs | The early tranches get out of trouble and bank first, which is easier psychologically |
| Disadvantage | Requires price to come back a little above the overall average | The deeply trapped later tranches wait a long time and keep their margin occupied |

### 7.2 That trap: the take-profit price must be recomputed from the *current actual* position

This is **the easiest thing in the whole strategy to get wrong, and the most damaging when you do**.

Suppose you only had one number: "the projected average of 972.58 after all 5 layers are stacked". If the program used that to compute the take-profit price:

```
972.58 × (1 + 0.5%) = 977.44
```

But you have **only opened tranche 1**, the actual average is 1000.2, and the current price is 1000.

So the condition "price ≥ 977.44 → take profit" **is already true at the current price of 1000** — the bot would close the position on the very next tick after opening it, **paying two sets of fees for nothing**.

Therefore the take-profit price in the program is always:

```
止盈价 = 当前实际持仓均价 × (1 ± 止盈幅度)
```

and never "the projected average once fully stacked". If you look at the take-profit price written on each row of the plan preview table, it means **"what the take-profit price will become once that layer is added"** — a projection for your reference, not the execution price in force now.

**The same applies to the stop-loss**: always recomputed from the current actual average, and it must sit between the entry price and the liquidation price.

## VIII. How the stop-loss relates to liquidation

**Liquidation (blowing up) is an accident that must be avoided at all costs; the stop-loss is accepting a loss voluntarily.** Both mean "close everything when price moves against you to some level", but they are entirely different in nature:

| | Stop-loss (the program closes voluntarily) | Liquidation (the exchange closes by force) |
| --- | --- | --- |
| Who executes | The bot places the order itself | The exchange's risk engine |
| Loss | Exactly the amount the stop-loss defines | All margin is lost, and in extreme markets possibly more |
| Can it be avoided | Yes — you set it, it is under control | Only avoided through the stop-loss and low leverage |

So the iron rule is: **the stop-loss price must trigger earlier than the liquidation price, with a buffer in between.**

The formula the program uses for the liquidation price (long side; short side mirrors it):

```
强平价 = (持仓数量 × 持仓均价 − 账户权益) ÷ (持仓数量 × 0.995)
```

That 0.995 is an approximation of Binance's maintenance margin rate (0.5%).

Then the stop-loss price is computed:

1. First compute a value as "average price × (1 − stop-loss band%)";
2. If that value sits too close to the liquidation price, lift it in the safe direction, **leaving at least 20% of the distance from the liquidation price to the entry price as a buffer**;
3. Finally clamp it: the stop-loss price may not equal the entry price (that would stop out the instant the position opens).

The actual numbers with the default parameters (long side, entering at 1000):

| Metric | Value | Notes |
| --- | --- | --- |
| Average after full stacking | 972.58 | All 5 layers added |
| Stop-loss price | **923.95** | 5% below the average |
| Liquidation price | **606.86** | Price must fall 37.6% to blow up |
| Distance between them | 317 U | A very comfortable buffer |

The buffer is generous because, once all 5 layers are stacked, only 13.19 U of margin is reserved — a very light position relative to 100 U of account equity. **But push leverage to 50×** and the liquidation price closes in fast; the stop-loss becomes very narrow or even overlaps liquidation. At that point the program refuses that layer plan and tells you 「止损价与强平价重叠：这个杠杆下仓位太危险」 (stop-loss price overlaps the liquidation price: the position is too dangerous at this leverage).

## IX. Minimum order amount: even small money may not open a position

This is where beginners get stuck most often. Binance imposes **two thresholds** on every order, and both must be satisfied:

| Threshold | Meaning | Default value |
| --- | --- | --- |
| Minimum notional (`minNotional`) | The total value of the order cannot be too small | **5 USDT** for most USDⓈ-M contracts (whatever the exchange returns; the program does not hard-code it) |
| Minimum quantity step (`minQty` / `stepSize`) | Quantity must be a whole multiple of some minimum tick | Set per instrument, e.g. 0.001 or 0.01 |

So the "minimum order amount" the program computes is **the stricter of the two limits**:

```
最小可下单金额 = max( 交易所最小名义额 , 向上取整(最小数量 / 步长) × 步长 × 现价 )
```

An example: a contract where `minQty` = `stepSize` = 0.01 (you can only buy multiples of 0.01) and the current price is **976**.

- Notional threshold: 5 USDT
- Quantity threshold: 0.01 × 976 = **9.76 USDT**

9.76 is larger than 5, so the **true minimum order amount for this instrument is 9.76 USDT**, not 5 U. If your first tranche computes to 7 U, the program refuses it and tells you what to change the allocated capital or first-tranche share to.

**This is why "allocated capital 24 U + first tranche 1% + 20× leverage" cannot open a position**: 24 × 1% × 20 = a notional of only 4.8 U, which does not even clear the 5 U threshold.

## X. The risks of this strategy (the honest version)

Everything above is theory; this section is about **where you can lose money**, so please read it to the end.

| Risk | What actually happens | Severity |
| --- | --- | --- |
| **One-way trend, adding all the way down and getting trapped** | Long-only, price falls from 1000 to **932.8**: the bot stacks all 5 layers, dilutes the average to 981.87, then hits the stop-loss and loses 13.5% of the allocated capital in one go. With no stop-loss, or a very wide one, it rides it all the way into liquidation | ⚠️⚠️⚠️ Most deadly |
| **Leverage multiplies the speed of loss** | 20× leverage means a 5% move against you **wipes out that position's margin entirely**. Leverage is not a way to earn more; it multiplies the effect of the same price move on your capital by N | ⚠️⚠️⚠️ |
| **Only covers the specified decline** | If price gaps straight through all your add-on lines (say from 1000 to 900), the bot can only add around the price after the gap, the average does not come down, and it goes straight to the stop-loss | ⚠️⚠️ |
| **Fees bleed continuously** | Take-profit 0.5%, round-trip fees 0.1% + slippage 0.04% (about 0.14% in total), leaving only **0.36%** net. Set take-profit below 0.1% and the gain does not even cover the toll — **every single trade loses money** | ⚠️⚠️ |
| **Not enough oscillation = ground to death** | Price grinds around the average, reaching neither the take-profit line nor the add-on line. The bot just holds, pays the entry fee, and earns nothing | ⚠️ |
| **Aggressive parameters = faster trip to zero** | High leverage + tight spacing + a large multiplier will make risk control trim the layers to very few and squeeze the stop-loss extremely narrow, so any wobble stops you out. **The aggressive preset is not "earns more", it is "blows up sooner"** | ⚠️⚠️⚠️ |
| **Multiple bots sharing an account** | Every bot reserves margin in the same account, and together they may exceed what the account can actually carry. The program has a budget gate that stops a single bot overspending, but **it cannot stop you running 10 bots that all lose together** | ⚠️⚠️ |
| **The program is not omnipotent** | Network drops, the API gets rate-limited, the computer shuts down, the process is killed — the bot stops. The positions you then hold are **unprotected by the program** (in live mode it places exchange-side conditional orders as a fallback where possible, but that is not guaranteed) | ⚠️⚠️ |

**The risks in one sentence: this strategy is a small trickle in an oscillating market and a money shredder in a trending one. It will not make you rich, but careless parameter changes can wipe you out fast.**

## XI. How to tune the parameters: conservative / neutral / aggressive

All three presets below have **actually been through the computation** (allocated capital 100 U, price 1000), so you can copy them directly. But read the "measured results" before you choose.

### 11.1 The three parameter sets

| Parameter | Conservative | Neutral (default) | Aggressive |
| --- | --- | --- | --- |
| 交易方向 (Trading direction) | 双向 (dual) | 双向 (dual) | 双向 (dual) |
| 分配资金 (Allocated capital) | 100 | 100 | 100 |
| 第一笔保证金占比 (First tranche margin share) | 1% | 1% | 1% |
| 杠杆倍数 (Leverage) | **5** | **20** | **50** |
| 加仓倍数 (Add-on multiplier) | 1.5 | 1.5 | 1.5 |
| 加仓间距 (Add-on spacing) | **2%** | 1% | **0.5%** |
| 层数上限 (Layer cap) | 4 | 6 | 10 |
| 单方向总投入 (Total commitment per direction) | 2× | 3× | 4× |
| 最大亏损占比 (Maximum loss share) | **20%** | 35% | 50% |
| 止盈方式 (Take-profit mode) | 整体 (whole-position) | 整体 (whole-position) | 整体 (whole-position) |
| 止盈幅度 (Take-profit band) | 1% | 0.5% | 0.5% |
| 止损幅度 (Stop-loss band) | **8%** | 5% | **2%** |
| 判断周期 (Decision interval) | 15m | 5m | 5m |

### 11.2 Measured results (very important — do not look at the parameters alone)

| Measured item | Conservative | Neutral | Aggressive |
| --- | --- | --- | --- |
| Parameters pass validation | ✅ | ✅ | ✅ |
| Layers wanted → layers actually granted | 4 → **4 layers (all granted)** | 6 → **5 layers (1 trimmed)** | 10 → **3 layers (7 trimmed)** |
| First tranche notional / margin | 5 U / 1 U | 20 U / 1 U | 50 U / 1 U |
| Total notional when fully stacked | 40.6 U | 263.8 U | 237.5 U |
| Total margin when fully stacked | 8.1 U | 13.2 U | 4.75 U |
| Worst-case loss | 3.25 U (3.3%) | 13.19 U (13.2%) | 4.75 U (4.75%) |
| Stop-loss price when fully stacked | 883.65 | 923.95 | **973.81** (only 2% from the average) |
| Liquidation price | **0 (computes negative, meaning it cannot blow up)** | 606.86 | 578.18 |

**The key to reading this table:**

- **Conservative**: low leverage, wide spacing, generous stop-loss — every parameter is usable. Each trade makes less and loses less, so it suits a beginner.
- **Neutral**: the defaults, balanced. But note that it automatically trims one layer.
- **Aggressive**: looks like the most layers and the highest leverage, **but you actually get only 3 layers, and the stop-loss is squeezed to just 2% from the average**. In other words, the slightest wobble stops you out. This is not "more aggressive so it earns more", it is "stopping out faster and more often".

### 11.3 Three rules of thumb for tuning

1. **Adjust leverage first, not the spacing.** Leverage is the single biggest lever on the distance to liquidation; dropping it from 20 to 5 pushes the liquidation price so far away it is nearly unreachable.
2. **The stop-loss band should be at least 3× the add-on spacing.** Otherwise the first tranche is stopped out before price ever reaches the add-on line.
3. **Keep the take-profit band at 0.3% or above.** Round-trip fees are about 0.1%; below 0.3% you are basically working for the exchange.

## XII. What to read next

| If you want to know | Read this |
| --- | --- |
| How to get running from zero (7 steps) | [QUICKSTART.md](QUICKSTART.md) |
| The various errors and questions | [FAQ.md](FAQ.md) |
| Overall program architecture and how data is stored | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Deploying to a server, HTTPS, backups | [DEPLOY.en.md](../../DEPLOY.en.md) |

> **One last word**: the essence of this bot is "trading money management for win rate" — it does not guess direction, it makes the money of oscillation through tranching down the average and taking profit quickly. The win rate can be very high, but **a single loss is always bigger than a single win**. The real risk control is not in the parameters; it is in how much money you are willing to give to one strategy.
