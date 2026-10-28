**English** ｜ [中文](SECURITY.md) ｜ [日本語](SECURITY.ja.md)

# Security Policy

This project is a trading tool that **places orders with real money**. This document explains how keys are protected, how sessions are managed, what to watch out for when deploying, and how to report a vulnerability privately.

---

## 1. Supported Versions

| Version | Support status |
|---|---|
| 1.0.x | ✅ Supported (security fixes ship here) |
| < 1.0 | ❌ Not supported |

Security fixes are released only for the latest version. When upgrading, just keep the `data/` directory — the database schema upgrades itself.

---

## 2. How to Report a Vulnerability

**Report privately through a GitHub Security Advisory. Do not open a public Issue.** Open the repository page → **Security** tab → **Advisories** → **Report a vulnerability**, and describe the impact, reproduction steps and consequences (can it read someone else's API Key? Can it operate another user's bot without authorization? Can it bypass the live-trading safety gate?). A minimal reproduction must **not** include real keys, accounts or server addresses.

We will confirm and assess severity as quickly as possible, and after a fix is ready we will agree a coordinated disclosure date with you; please do not publish details before the fix ships. Losses from operational mistakes, keys you leaked yourself, and issues on Binance's side are outside this process.

---

## 3. How Keys Are Protected

| Stage | Approach |
|---|---|
| Storage | Encrypted with **AES-256-GCM** and written to the `key_enc` / `secret_enc` columns of the `api_keys` table |
| Encryption format | `v1.<iv>.<tag>.<ciphertext>`, each segment Base64; `iv` is a 12-byte random value |
| Master key | A 32-byte random value stored in `data/master.key` (permissions **0600**), or supplied via the `BT_MASTER_KEY` environment variable (64 hex characters) |
| Precedence | The `BT_MASTER_KEY` environment variable **takes precedence over** the file; if neither exists, `data/master.key` is generated automatically |
| Return path | No endpoint ever returns plaintext; listings return only a masked value (first 4 characters + at least 16 `*` + last 4 characters) |
| Usage | Plaintext is used once in memory to sign a request and discarded immediately — **never written to logs** |

Login passwords use scrypt with a **per-user 16-byte random salt**, stored as `scrypt$<salt>$<hash>`; verification uses `timingSafeEqual` for a **timing-constant** comparison, so a password cannot be guessed from response times.

### ⚠️ Lose the master key = every API Key is unrecoverable

If `data/master.key` is lost, the encrypted keys cannot be recovered — you must regenerate them on Binance and enter them again. When backing up `data/app.db` you **must back up `master.key` along with it**, and keep the two **in separate places** (database on a backup server, master key in a password manager) — backing up the database alone is as good as no backup at all.

---

## 4. Session Security

| Item | Approach |
|---|---|
| Cookie name | `bt_sid` |
| HttpOnly | **Yes** — frontend JS cannot read the session token, so even XSS cannot steal it |
| SameSite | `Lax` — a cross-site form cannot carry the session to perform write operations |
| Secure | **Set automatically on HTTPS** (the backend looks at direct TLS or a proxy-forwarded `X-Forwarded-Proto: https`); omitted under HTTP, otherwise local debugging could not log in |
| Lifetime | **7 days**; the server can also invalidate it proactively |
| Server-side validation | Every request does a `JOIN sessions + users` and checks `expires_at`; expired sessions are immediately invalid |
| Login rate limiting | **5 attempts / minute** per username; beyond that returns `429` and "请 N 秒后重试" |
| Password policy | Username `[A-Za-z0-9_]{3,32}`, password 6–128 characters |

Logging out deletes the server-side session record and clears the cookie at the same time — it is not just deleting a browser cookie.

---

## 5. Deployment Security Recommendations

| Item | Requirement |
|---|---|
| Listen address | **`127.0.0.1`** by default; not exposed externally |
| Public internet | **Must** sit behind an HTTPS reverse proxy (Nginx / Caddy); never expose the Node port directly |
| Firewall | Allow only 22 / 443 (as needed); the Node port should be reachable from localhost only |
| `data/` permissions | `chmod 700`, owned by the account that runs the service |
| Backups | Regularly back up `data/app.db` **and `data/master.key`** — as a pair, stored separately |
| Run-as account | Run the systemd service as a normal user, never as root |
| System clock | Keep NTP synchronized; large drift makes request signatures fail with `-1021` |

See [DEPLOY.md](DEPLOY.en.md) for the concrete steps. **Reverse proxy caveat**: when deployed under a sub-path (`BASE_PATH`), do not append a URI after `proxy_pass` — let the backend strip the prefix itself; and make sure the proxy timeout is longer than the Binance API timeout (8 seconds by default), otherwise you can end up with the dangerous state where "the frontend sees a 502 but the order has already gone out".

---

## 6. Minimizing API Key Permissions

| Permission | Enable? |
|---|---|
| Read | ✅ Required |
| Enable Futures | ✅ Required |
| **Enable Withdrawals** | ❌ **Absolutely never** |
| Spot trading, margin, transfers | ❌ Not needed |
| IP whitelist | ✅ **Strongly recommended** — bind the server's egress IP |

Even though the program itself has no withdrawal capability, withdrawal permission should never be granted — if the master key leaks, an attacker will simply transfer the funds out, whereas trading permission can only let an attacker lose money for you. Two extra safeguards are recommended: run the bot on a **dedicated small-balance account**, and enable Binance's account-level transfer restrictions.

---

## 7. `LIVE_TRADING=1` Is the Only Live-Trading Master Switch

| Item | Description |
|---|---|
| Default value | **Off.** When unset, the platform only reads market data and never places an order |
| Uniqueness | Only the `LIVE_TRADING=1` environment variable can turn it on — no config file, no UI toggle |
| When it takes effect | Read once at process start; a restart returns it to the off state |
| Layers of blocking | ① Starting a live bot is rejected (`400 LIVE_DISABLED`); ② every order is blocked again before submission and a `warn` event is written |

Paper mode and live mode are two independent implementations; nothing you do in paper mode can trigger a real order. **Run in paper mode for at least two weeks** before considering flipping this switch.

---

## 8. Security Mechanisms Already Implemented

| Mechanism | Location | Purpose |
|---|---|---|
| Fully parameterized SQL | `src/db.js` and all call sites | No string concatenation, eliminating injection |
| Resource ownership checks | `ownedRobot` in `src/routers/robots.js` | Always `WHERE id=? AND user_id=?`; user A cannot modify user B's bots, keys or orders |
| Passwords and sessions | `src/auth.js`, `src/crypto.js` | scrypt + random salt + timing-constant comparison; HttpOnly / SameSite=Lax cookie |
| Login rate limiting | `src/auth.js` | 5 attempts / minute per username |
| Key encryption | `src/crypto.js` | AES-256-GCM; master key from a 0600 file or the environment |
| Directory traversal protection | `src/http.js` | After normalization, verifies `full.startsWith(STATIC_DIR + sep)`; out-of-bounds requests get 403 |
| Request body limit / unified error exit | `src/http.js` | Over 1MB returns 413 immediately; any unhandled exception becomes `500 INTERNAL_ERROR` with no stack trace returned |
| Deterministic `clientOrderId` | `src/binance/live.js` | A resend after a timeout is rejected by the exchange as a duplicate id, then the order is confirmed by querying that id — **preventing duplicate orders** |
| No automatic order retries | `src/binance/rest.js` | Only `GET` and cancel `DELETE` are retried; order `POST` is never retried |
| Live position ledger isolation | `src/strategy/liveBook.js` | Closes only positions the bot opened itself — **never touches a position the user opened manually** |
| Protection orders never use `closePosition` | `src/strategy/protect.js` | Conditional order quantity covers only the bot's own share, so an entire side of the position is not closed at once |
| Take profit / stop loss defer to the exchange | `src/binance/protection.js` | Fills and open orders follow what Binance returns; the platform does not invent prices |
| Live-trading safety gate / precision normalization | `src/config.js`, `src/binance/live.js` | Orders allowed only when `LIVE_TRADING=1`; normalized by `stepSize`/`tickSize`, and on `-1111` the precision is stepped down level by level |

---

## 9. Notes for Users

**Don't:** run it on a shared machine or someone else's computer; commit `data/` to git or zip it up for others; send `data/master.key` to anyone (including someone offering to "help you debug"); post API Keys, Secrets, session cookies or account balances in screenshots, Issues or chat groups; expose the Node port directly to the internet or access it over plain HTTP; grant withdrawal permission to an API Key.

**Do:** run paper mode for at least two weeks before going live, then run live with a very small real balance for a week; bind an IP whitelist to the API Key and enable futures trading only; regularly review your Binance account and API Key records and delete any suspicious key immediately; back up `data/app.db` and `data/master.key` and store them separately; keep Node and the OS updated and watch the repository's Releases and Security Advisories; whenever something feels wrong, **stop the bot first** and then investigate.

---

## 10. Threat Model

The design assumption of this project is: **a single user, a single machine, a personal service on a trusted network or exposed through an HTTPS reverse proxy**. It does not provide multi-tenant isolation (all accounts share one process and one database file), nor does it protect against other local users on the same machine.

The following are **not** covered by the security promise: the server has already been compromised (an attacker can read `data/`, and the master key leaks with it); you handed your account password or `data/` to someone else; you run it on an untrusted machine (keyloggers, process memory reads); you granted withdrawal permission to an API Key and either the master key or the Key leaks. Under those conditions no software can protect the funds. Treat it as **a safe that you are responsible for guarding the key to**.
