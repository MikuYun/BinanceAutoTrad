**English** ｜ [中文](../FAQ.md) ｜ [日本語](../ja/FAQ.md)

# Frequently Asked Questions (FAQ)

> Everything you are most likely to run into once it is up and running. For your first time through, start with [QUICKSTART.md](QUICKSTART.md); for how the strategy works see [STRATEGY.md](STRATEGY.md); for deployment / HTTPS / backups see [DEPLOY.en.md](../../DEPLOY.en.md).

## I. Installation and startup

### Q1: What do I need to install? How new does Node have to be? Why does anything below 22.5 fail?

Install **Node.js** and nothing else. **≥ 22.5** is required; **Node 24 LTS** is recommended (`package.json` carries `"engines": { "node": ">=22.5.0" }`).

22.5 is the floor because the program stores its database with Node's built-in `node:sqlite`, and that module **only exists from 22.5 onward**. On an older version startup fails outright with:

```
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
```

Check with `node -v`. Printing `v22.5.0` or higher is fine; `v18.x` / `v20.x` must be upgraded; 「找不到命令」 (command not found) means it is not installed. After installing, **close the terminal and open a new one**, or the environment variables will not take effect.

### Q2: Do I need to run `npm install`?

**No.** This project has zero third-party dependencies and will not even create `node_modules`. All three commands work directly: `node server.js` starts the service, `node scripts/check.js` syntax-checks every file, `node --test scripts/` runs the unit tests.

### Q3: How do I start it on Windows?

Use **PowerShell** (not cmd — setting environment variables works differently):

```powershell
cd B:\biance_trae
node server.js
```

Once you see 「监听地址：127.0.0.1:8787 / 实盘下单：已关闭（安全闸，只读）」 (listening on 127.0.0.1:8787 / live orders: off, safety gate, read-only) it worked; open <http://127.0.0.1:8787> in your browser. macOS / Linux are the same: `cd` into the project directory and run `node server.js`.

### Q4: Port 8787 is taken — what do I do? How do I change the port?

An `EADDRINUSE` in the error means the port is occupied. Two options:

```bash
# Option 1: find the occupant and kill it
ss -lntp | grep 8787            # Linux/macOS, take the PID and kill it
netstat -ano | findstr :8787    # Windows, then taskkill /PID <PID> /F
```

```powershell
# Option 2 (recommended): just change the port
$env:PORT=9000; node server.js          # Windows PowerShell
PORT=9000 node server.js                # macOS / Linux
```

Then visit `http://127.0.0.1:9000`.

### Q5: What is `HOST`? Why can nobody else — say, my phone — reach it?

`HOST` defaults to `127.0.0.1`, meaning **only this machine can connect** — that is the safe default. Switch it to `0.0.0.0` only when you want devices on your LAN to get in, and **public access absolutely requires an HTTPS reverse proxy**; do not expose `8787` directly (see [DEPLOY.en.md](../../DEPLOY.en.md) section 5).

### Q6: When I close the terminal window, the service dies?

Correct — that window *is* the service, so **closing it stops everything**. For always-on operation: systemd on Linux ([DEPLOY.en.md](../../DEPLOY.en.md) section 4), Task Scheduler on Windows.

The good news: after a restart, **every bot whose status is "running" is recovered automatically**, and the event log records 「服务重启，机器人已恢复运行」 (service restarted, bots resumed running).

## II. Accounts and sign-in

### Q7: How do I register the first account?

Open the home page → the 「注册」 (Register) tab → fill in two fields: username **3–32** letters/digits/underscores, password **6–128** characters → click 「注册并登录」 (Register and sign in). A successful registration **logs you in immediately**.

These are **purely local accounts**, stored only in `data/app.db` on your own machine. No email, no phone number, and nothing is uploaded anywhere.

### Q8: I forgot my password — what now? And what does 「尝试次数过多」 (too many attempts) mean?

**There is no password recovery** — the account data lives only on your machine, so there is no mailbox to verify against. You have exactly two routes: delete `data/app.db` and start over (you lose all data), or, if you can write code, go straight at the database (passwords sit in the `users` table as `scrypt$盐$哈希`, i.e. scrypt + salt + hash). **Write the password down when you register.**

「尝试次数过多，请 N 秒后重试」 (too many attempts, retry in N seconds) is brute-force protection: **at most 5 failures per username per minute**; wait out the seconds it gives you. A login lasts **7 days** (cookie `bt_sid`, `httpOnly`, so scripts cannot read it and cookie theft is harder).

## III. Paper trading

### Q9: What exactly is the difference between paper mode and live mode?

| | Paper mode | Live mode |
| --- | --- | --- |
| Money | Virtual funds, any amount you like | Real USDT |
| Fills | Matched locally by the program | Real orders sent to Binance |
| Prices | **The same real market data as live mode** | Real market data |
| Fees | A fixed 0.05% | Your actual fee rate |
| Slippage | A fixed 0.02% | Determined by real order-book depth |
| Risk | Zero | You can lose everything |

**Always run paper mode first**, long enough to understand the flow and the layer table, before you even consider live mode.

### Q10: Are paper-mode prices real?

**Yes.** By default it connects directly to Binance futures market data. Only when your network cannot reach Binance does it **degrade automatically to locally simulated prices** and say so on the page. To force local simulated prices (offline demo): `$env:BINANCE_FEED="mock"; node server.js`.

### Q11: How do I change the paper-mode balance?

「账户」 (Account) page → 「设置模拟余额」 (Set paper balance) in the top right. Rules: minimum **10 USDT** (below that you get 「模拟资金不能小于 10 USDT」, paper funds cannot be less than 10 USDT), maximum **10,000,000 USDT**, and a new account starts at 100.

⚠️ The default handling is 「重置钱包，并清空所有机器人的持仓」 (reset the wallet and clear every bot's positions) — **changing the balance wipes the positions and orders of all paper bots**. This wallet is **account-level**: every paper bot shares one balance, and each bot then uses its own 「分配给这个机器人的资金」 (capital allocated to this bot) to cap how much it may move, so the same money cannot be staked twice.

### Q12: How are paper-mode fees and slippage calculated? Is it more optimistic than live?

Two hard-coded constants: fee **0.0005** (0.05% of each notional, once on entry and once on exit) and slippage **0.0002** (0.02% between fill price and mid price). So one entry-and-exit round trip costs roughly **0.14%** — with take-profit set at 0.1%, the profit does not even cover the fees.

Paper mode assumes "market orders fill instantly and completely, with fixed slippage"; it does not model thin order books, partial fills, or rejections during extreme moves. **So a large position will look more optimistic in paper mode than it would in live mode** — do not treat paper returns as a live forecast.

## IV. Bots and strategy

### Q13: Why does creating a bot return 「参数不可行」 (parameters not viable)?

The API returns the specific Chinese reason; the three most common:

1. **First tranche too small**: the first tranche's notional is below the minimum order amount for this instrument. Example: 5 U allocated + 1% first tranche + 20× leverage = **1 U**, which cannot even clear the 5 U threshold.
2. **First tranche too heavy**: the first tranche's notional exceeds 400% of the allocated capital (e.g. 20% first tranche × 20× = 400%).
3. **The first tranche alone already breaches the per-direction commitment cap** (「单方向总投入上限」).

The mechanism: first tranche notional = allocated capital × first-tranche share × leverage. For a bigger first tranche, **raise the allocated capital, raise the first-tranche share, or raise the leverage**. The message computes the "raise it to at least …" figure for you; just apply it.

### Q14: What does 「最小可下单金额」 (minimum order amount) mean?

Binance imposes **two floors** on every order, and the program takes the larger one:

```
最小可下单金额 = max(交易所最小名义额, 数量步长向上取整 × 步长 × 当前价格)
```

In English: minimum order notional = max(the exchange's minimum notional, ceiling of quantity in step units × step size × current price).

- **Minimum notional**: **5 USDT** on most contracts. Notional = quantity × price, **not margin**.
- **Quantity step**: the smallest quantity unit this contract accepts; a step of 0.01 means the smallest order is 0.01 contracts.

Example: a contract priced **976 USDT** with a step of **0.01** — the smallest clip of 0.01 is worth **9.76 USDT**, larger than 5 U, so the real threshold is **9.76 U**. That is exactly why "24 U allocated + 1% first tranche + 20× = 4.8 U" cannot open a position: it is just short.

### Q15: The bot is created — why does it never do anything?

**Most likely it is behaving normally.** It is built to "wait until price reaches a planned level before acting": with no position it opens the first tranche on the very first tick, and after that it waits for price to reach an **add-on line** to add, or a **take-profit / stop-loss line** to close. Several hours without action is entirely normal.

Open the **event log** on the 「详情」 (Detail) page; every round's decision and its reason is written there. If even the first tranche was never opened, check two things: ① whether the first-tranche amount clears the minimum order notional; ② whether the paper wallet's **available balance** covers that margin (if not the order is refused and the log says 「开仓被拒：账户可用余额不足」, order rejected: insufficient available balance).

### Q16: Why aren't all the layers there from the start? The layer table clearly shows 5 layers

Because **the layer table is a "plan", not "fills"**. The program opens **one tranche at a time**, and only adds the next one when price actually reaches the next add-on line. Each row means "if price gets here and I add this tranche, this is what my average price / take-profit / stop-loss will become" — a projection.

Also, **you do not necessarily get all the layers you asked for**: ask for 6 and the program often computes only 5, because one more would breach the 「最大亏损」 (maximum loss) or 「单方向总投入」 (per-direction commitment) cap you set. The preview and the log say so outright: 「层数从 6 自动降到 5」 (layers trimmed from 6 to 5).

### Q17: How do I choose between 「整体止盈」 (whole-position take-profit) and 「逐笔止盈」 (per-tranche take-profit)?

| Mode | How it closes | Who it suits |
| --- | --- | --- |
| **整体 (默认)** (whole-position, default) | Waits for the **current actual average entry price** to reach +take-profit, then closes everything at once | Most people — simple, cheaper on fees |
| **逐笔** (per-tranche) | Each tranche closes on its own once price is above its entry | People who want the early tranches banked and the position size reduced |

Per-tranche mode spreads fees more thinly, and it can leave the last few tranches waiting indefinitely.

### Q18: Why is the take-profit price in the preview table different from what I see on the live side?

**It is deliberate, and it has to be.** The program computes take-profit from **the average price of the position you actually hold right now**, not from the projected average after everything is stacked.

If it used the fully-stacked projected average, then while you hold only 1 tranche the computed take-profit would land on the **wrong side** of the current price, and the result would be **an instant close the moment you open** — paying fees for nothing. So take-profit must always be computed from the real current position. See [STRATEGY.md](STRATEGY.md) section VII for the full explanation.

### Q19: How many bots can one account have? What is the difference between 「停止」, 「重置」 and 「删除」?

At most **20** (beyond that the API answers 「最多创建 20 个机器人」, at most 20 bots). The operations differ:

| Operation | Positions | Ledger | When to use it |
| --- | --- | --- | --- |
| **停止** (Stop) | Kept by default; 「同时平仓」 (also close positions) can be ticked | Kept | Pause for a while |
| **重置** (Reset) | Paper mode: cleared; live mode: **exchange positions are not closed** | Cleared, recomputed from layer 0 | You want a fresh start |
| **删除** (Delete) | Same as reset | Also deletes orders, events, curve | You no longer want the bot |

⚠️ **The live-mode "reset" trap**: it only clears the bot's own ledger; the positions remain on the exchange. After a restart those positions are **taken over by the bot**: it computes a take-profit from the exchange's real average entry and closes the whole side in one go when that level is hit. So after a reset the bot adopts the position instead of ignoring it.

Changing parameters requires **stopping** the bot first (a running bot answers 「请先停止机器人再修改参数」, stop the bot before changing parameters).

## V. Live trading and API keys

### Q20: How do I fill in an API key?

On the Binance website → API management → create an API key (choose "System generated") → back in this program's 「API Key」 page → 「添加」 (Add): a note (anything, max 40 characters), the API Key, and the API Secret (**Binance shows it only once**).

After saving, click 「**验证**」 (Verify); you must see 「验证通过，合约账户权益 X USDT」 (verification passed, futures account equity X USDT) before it counts as configured. You can save without the Secret first (the status becomes 「待补全」, incomplete), but **a Key without a Secret cannot read any balance** — Binance account endpoints must be signed with the Secret.

### Q21: Which permissions does the API key need?

| Permission | Needed? | Notes |
| --- | --- | --- |
| 读取（Read） (Read) | ✅ Yes | Reading balances and positions |
| 合约交易（Enable Futures） (Futures trading) | ✅ Yes | Placing and cancelling orders, setting leverage |
| 现货交易 (Spot trading) | ❌ No | This program does no spot trading |
| **提现（Withdraw）** (Withdrawals) | ❌ **Absolutely not** | The bot never needs to withdraw |
| IP 白名单 (IP whitelist) | ✅ Strongly recommended | Allow only your server's IP |

**Treat "withdrawals disabled" as an iron rule**: the worst case for a leaked key is bad trades, not money being transferred out.

### Q22: Why does starting a live bot return `LIVE_DISABLED`?

The message, verbatim:

> 实盘下单安全闸未开启：服务启动时需设置环境变量 LIVE_TRADING=1 才能启动实盘机器人。当前部署只读取行情与账户，不会向币安发送任何订单。

In English: the live-order safety gate is closed — the service must be started with the environment variable `LIVE_TRADING=1` before live bots can run. This deployment only reads market data and the account, and will not send any order to Binance.

This is a **deliberate safety gate**: by default the program is entirely read-only towards Binance, so even clicking 「实盘启动」 (Start live) will not place a real order. To place real live orders you must **restart the service** with:

```powershell
$env:LIVE_TRADING="1"; node server.js    # Windows PowerShell
LIVE_TRADING=1 node server.js            # macOS / Linux
```

The startup log switches from 「实盘下单：已关闭（安全闸，只读）」 (live orders: off, safety gate, read-only) to 「**已开启**」 (on). If nothing changes, the variable did not take effect (usually because cmd was used instead of PowerShell, or because the service was not restarted).

### Q23: Why does the live account page show no data?

The program does not crash; it tells you the specific reason:

| Message on the page | Cause | What to do |
| --- | --- | --- |
| 尚未配置 API Key (no API key configured) | None was ever added | Add one on the 「API Key」 page |
| 缺少 API Secret (API secret missing) | Only the Key was filled in | Fill in the Secret |
| 已保存但尚未验证通过 (saved but not yet verified) | Verification was never run, or it failed | Run Verify and read the error |
| 无法连接币安：… (cannot reach Binance…) | Network blocked / behind the GFW / proxy needed | See the checks below |

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://fapi.binance.com/fapi/v1/time  # expect 200
curl -s https://api.ipify.org; echo                                            # egress IP
timedatectl status                                                            # clock must be accurate
```

The egress IP must match the key's IP whitelist, otherwise you get `-2015`; an inaccurate clock gives `-1021`.

### Q24: Will the bot close positions I opened by hand?

**Yes — and that is the intended design** (changed in 1.0.2 at the user's request).

Under Binance hedge mode, longs in the same symbol are **aggregated at account level** — the exchange cannot tell which order belongs to whom. So the program maintains 「本机器人自己的持仓账本」 (the bot's own position ledger) inside `state_json` and reconciles it against the exchange every round:

- The exchange shows **more** than the ledger → the excess is **taken over into the ledger entirely**: 「接管：多单已有 N 张不是机器人开的仓位，已全部接管（实际均价 X）。接管仓位不加仓，等止盈价 Y 一次性全平。」 (Takeover: N long contracts that were not opened by the bot have been adopted at the real average entry X; adopted positions are not scaled in and are closed in one go at take-profit Y.)
- The exchange shows **less** than the ledger → it assumes you closed part of it by hand and shrinks the ledger (tolerance = half of the quantity step size).

While in takeover mode the bot **does not add to the position**; it waits for the take-profit computed from the exchange's real average entry and closes the **whole side in one go**, then rebuilds the first tranche.

> Why this design: earlier versions "never touched manual positions", which left the bot's ledger permanently out of sync with the exchange and actually caused a live incident. The current principle is that **the exchange is the only source of truth** — every position on that symbol belongs to the bot.
>
> If you **really don't** want the bot to touch a position, the way to do it is: **don't assign that symbol to a bot** (or close it by hand before starting the bot).

### Q25: Are take-profit and stop-loss monitored by the program, or resting on the exchange?

The program checks the price every **5 seconds** (adjustable with the environment variable `TICK_INTERVAL_MS`) and closes at market when a level is hit; in live mode it **also** keeps exchange-side conditional orders in sync (since 1.0.2 these go through the **Algo Order API**, because Binance has disabled `STOP_MARKET` / `TAKE_PROFIT_MARKET` on `/fapi/v1/order`), reconciling every 60 seconds by cancelling the old ones and placing new ones. The point of running both legs: **if the program dies, the network drops, or the machine shuts down, a protective order is still resting on the exchange**. The conditional order quantity covers the full ledger quantity for that side (in takeover mode that already includes positions that existed on the exchange); if one cannot be placed, an error-level event is logged — it never fails silently.

### Q26: Do I need 「双向持仓模式」 (hedge mode)? Do positions survive a server restart?

**Yes, you need it.** The program places orders hedge-mode style: longs tagged `LONG`, shorts tagged `SHORT`. On Binance futures: top-right settings → 「持仓模式」 (position mode) → hedge mode (you must close all positions before switching).

After a restart: **bots** recover automatically; **positions** never left the exchange (a restart does not close anything); the **ledger** lives in the database and keeps working, so it will not mistake its own positions for manual ones.

## VI. Error code reference

### Q27: What do those Binance `-1xxx` codes actually mean?

| Code | Plain-language meaning | What the program does | What you should do |
| --- | --- | --- | --- |
| `-1021` | 时间戳超出允许范围 (timestamp outside the allowed range) | Re-syncs the clock and retries once | Fix the system clock |
| `-1022` | 签名不对 (signature invalid) | Re-syncs the clock and retries once | Paste the Secret again |
| `-1111` | 数量小数位太多 (too many decimal places on the quantity) | Drops precision and resends | Normally nothing |
| `-4164` | 金额/精度不达标 (amount or precision not acceptable) | Same as `-1111` | Raise the first-tranche amount |
| `-1106` | 不该带 reduceOnly 却带了 (reduceOnly sent when it should not be) | Already avoided by position mode | Check the Binance position mode |
| `-2019` | 保证金不足 (margin is insufficient) | Not translated; the original text is passed through | Lower leverage, shrink the position |
| `-2015` | Key 错/没权限/IP 不符 (bad key, no permission, or IP mismatch) | Reports 「API Key 或 Secret 错误，或密钥没有合约账户读取权限」 | Check permissions and the IP whitelist |
| `-1003` | 请求太频繁被限频 (rate limited) | Logs the error, retries next round | Run fewer bots, widen the interval |
| `-1007` | 服务器超时，不知成交没 (server timeout, fill status unknown) | Looks the order up by id, never re-sends | Normally nothing |
| `-4046` | 重复设置同一参数 (the same parameter set twice) | Treated as success (leverage already matches) | Nothing |
| `-2013` | 订单不存在 (order does not exist) | Assumes it closed and syncs the ledger | Normally nothing |

### Q28: `-1021` / `-1022` timestamp and signature errors

**Cause**: Binance requires every request to carry a timestamp that falls inside `recvWindow` (5000 milliseconds in this project). A local clock off by a few seconds is enough to be rejected.

**The program**: it re-syncs with Binance every 60 seconds in the background, and on `-1021` / `-1022` it **forces a re-sync and retries once**.

**You**: if it keeps happening, your machine's clock really is off — on Linux run `sudo timedatectl set-ntp true`, on Windows use 「设置→时间和语言→立即同步」 (Settings → Time & language → Sync now). If the clock is fine and `-1022` persists, it is almost always **a badly pasted Secret** (a stray space, a missing character).

### Q29: `-1111` / `-4164` precision errors

**Cause**: Binance fixes how many decimal places each contract's quantity may have; with a step size of 0.01, ordering 0.019 is rejected.

**The program**: it **steps the precision down and resends** according to that contract's real `stepSize`; usually the first step succeeds, so in normal operation you never see this error.

**You**: if `-1111` repeats, the precision rules probably were not fetched (a network problem left fallback values in place) — delete `data/rules-cache.json` and restart the service to refetch. If `-4164` repeats, it is usually not precision but **the amount really being too small**; raise the allocated capital or the first-tranche share.

### Q30: `-1106` and reduceOnly

**Cause**: `reduceOnly` is the "reduce only, do not open" flag. Binance **rejects it outright under hedge mode**; only one-way position mode needs it.

**The program**: this is already handled — in hedge mode (`positionSide` set to `LONG` / `SHORT`) it **does not send it**, and only one-way mode does.

**You**: if you still hit it, check whether the Binance position mode was switched to 「单向持仓」 (one-way) and switch it back to hedge.

### Q31: `-2019` insufficient margin

**Cause**: not enough margin available to open this particular tranche. "Not enough" does not necessarily mean "no money" — it may be tied up in another position, or this bot may have used up its own budget.

**The program**: this error is **not specially translated**; Binance's English text is passed straight through (of the form 「币安接口错误：Margin is insufficient.」, Binance API error: Margin is insufficient.).

**You** (in this order): ① check on the 「账户」 (Account) page whether the available balance covers this margin; ② reduce 「第一笔保证金占比」 (the first-tranche margin share) or lower the leverage (note that **lower leverage ties up more margin for the same notional**); ③ check whether several bots running at once have eaten all the margin; ④ manual positions already on the live account also consume margin, so it may not be the program's fault at all.

## VII. Security

### Q32: Where are API keys stored? Are they safe?

In the local `data/app.db`, and **not in plaintext**:

| Item | Approach |
| --- | --- |
| Encryption algorithm | **AES-256-GCM** (with an integrity check, so tampering is detected) |
| Key source | `data/master.key` (32 random bytes, permissions `0600`) |
| Display in the UI | Masked keys only (first 4 characters + asterisks + last 4) |
| Login passwords | `scrypt` + a per-user random salt + constant-time comparison |

**With the database file in hand but no `master.key`, the keys cannot be decrypted.**

### Q33: What happens if I lose `data/master.key`?

**Every API key already stored can never be decrypted again.** The symptom: bots start fine, but the moment a key is read you get a decryption failure.

- **If you have a backup**: restore `master.key` and `app.db` **together** (they are a pair — swapping either one breaks the match).
- **If you do not**: delete the old keys and enter them again; `master.key` is regenerated automatically. You can also pin the key with the environment variable `BT_MASTER_KEY` (64 hex characters), but on a server other processes can read environment variables. **The one reliable approach: copy the whole of `data/` when you back up.**

### Q34: Can I put it on the public internet and use it from my phone? Is HTTPS mandatory?

**Yes, but you must do both of these**: ① put an **HTTPS reverse proxy** in front (Nginx + a certificate) and keep Node listening on `127.0.0.1` only; ② open only 22/80/443 in the firewall — `8787` must never be exposed to the internet directly.

**Why HTTPS is mandatory**: the login password and API keys travel in HTTP request bodies, and HTTP is plaintext — anyone on the same WiFi, or any node along the path, can read them. Configuration is in [DEPLOY.en.md](../../DEPLOY.en.md) section 5.

### Q35: Can the `data/` directory be committed to git?

**Absolutely not.** It contains `app.db` (encrypted keys, password hashes) and `master.key` (the decryption key); leak both together and the keys are directly usable.

Note that SQLite runs in WAL mode, so `data/` holds `app.db`, `app.db-wal` and `app.db-shm` at the same time — **back up / copy all of them together**; copying only `app.db` may lose the most recent writes.

## VIII. Deployment and operations

### Q36: How do I keep it running on a server?

On Linux, host it with **systemd** — it starts at boot and restarts automatically if it crashes. The full unit file is in [DEPLOY.en.md](../../DEPLOY.en.md) section 4. Key points: set the environment variables in the unit (`HOST` / `PORT` / `LIVE_TRADING`), and `WorkingDirectory` must point at the project root, or `data/` will be created somewhere else.

### Q37: How do I configure a reverse proxy and HTTPS?

See [DEPLOY.en.md](../../DEPLOY.en.md) section 5 (Nginx configuration, certbot certificates, and `BASE_PATH` for sub-path deployments). The easiest trap to fall into: the proxy must pass through the `Host` and `X-Forwarded-Proto` headers, otherwise the backend treats an HTTPS request as HTTP and your login session mysteriously keeps dropping.

### Q38: How do I back up, upgrade and roll back?

**Back up the whole `data/` directory**, especially `app.db` (accounts / bots / orders / history) and `master.key` (lose it and every key is void). Pack it up on a schedule, keep a copy off-site, and always back up before upgrading. The backup itself is sensitive data — do not upload it to a public cloud drive or a git repository. Upgrade and rollback steps are in [DEPLOY.en.md](../../DEPLOY.en.md) section 7.

## IX. Still stuck?

Work through these in order: ① **the event log on the bot detail page** — every step of the program's reasoning is written there, and nine out of ten problems are explained right in it; ② **the terminal / service log** (`journalctl -u <service-name> -n 100 --no-pager`); ③ troubleshooting in [DEPLOY.en.md](../../DEPLOY.en.md) section 8; ④ open an issue on the project repository.

> ⚠️ When you paste logs, remember to **remove** API keys, secrets, server IPs and account passwords.
