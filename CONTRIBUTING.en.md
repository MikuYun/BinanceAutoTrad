**English** ｜ [中文](CONTRIBUTING.md) ｜ [日本語](CONTRIBUTING.ja.md)

# Contributing Guide

Thanks for wanting to improve this project. This document explains how to get the environment running, how the code should be written, and which checks must pass before you commit.

---

## 1. Development Environment

| Item | Requirement |
|---|---|
| Node.js | **>= 22.5** (the `engines.node` field in `package.json`); **24 LTS** recommended |
| Package manager | **Not required.** Zero third-party dependencies, so `npm install` can be skipped entirely |
| Operating system | Windows / macOS / Linux all work |
| Network | Live market data needs access to Binance `fapi.binance.com`; when it is unreachable the app falls back to local mock market data automatically |

Why the floor is 22.5: the database uses Node's built-in `node:sqlite`, a module that only ships from 22.5 onward. Starting on anything older throws immediately.

> The project has no `dependencies` / `devDependencies`. **Please do not pull in a third-party package just to make some feature easier to write.**
> Zero dependencies is a hard design constraint; the reasoning is in the "technology selection" section of [docs/ARCHITECTURE.md](docs/en/ARCHITECTURE.md).

---

## 2. Running It Locally

```bash
git clone https://github.com/MikuYun/BinanceAutoTrad.git
cd BinanceAutoTrad
node server.js     # 打开 http://127.0.0.1:8787 注册账号即可用模拟盘
```

**Windows PowerShell:**

```powershell
node server.js                              # 普通启动（模拟盘，安全）
$env:PORT = 9000; node server.js            # 换端口
$env:BINANCE_FEED = "mock"; node server.js  # 网络访问不了币安时用本地模拟行情
$env:LIVE_TRADING = "1"; node server.js     # 打开实盘下单开关（危险，重启即失效）
```

macOS / Linux work the same way: `PORT=9000 node server.js`, `BINANCE_FEED=mock node server.js`,
`LIVE_TRADING=1 node server.js`. The first run creates the `data/` directory, `app.db` and `master.key` automatically — **do not commit that directory**.

---

## 3. Code Conventions

| Rule | Guideline |
|---|---|
| Module system | ESM everywhere (`"type": "module"`), use `import` / `export`, never `require` |
| Built-in module prefix | Always write `node:`: `import { readFileSync } from 'node:fs'`, `import test from 'node:test'` |
| Third-party dependencies | **Not allowed.** Check first whether a Node built-in already covers the need |
| Comments | Use JSDoc block comments to explain *why* this file/function exists, written in Chinese; always state units in numeric math (USDT / contracts / percent) |
| Identifiers | Function and variable names stay English; error codes are upper snake case (`ROBOT_NOT_FOUND`); user-facing copy is Chinese |
| Error handling | Business errors go through `throw new HttpError(4xx, 'CODE', 'Chinese message')`; every side effect in `runner.js` is wrapped in `try/catch` — a failed log write must never interrupt trading |
| SQL | Parameter binding only (`?` placeholders), **string concatenation is forbidden** |
| Amounts and precision | Quantities and prices always go through `stepSize` / `tickSize` normalization; don't just `toFixed` and call it done |
| Frontend | Native ESM + native DOM, no frameworks; charts are hand-drawn SVG (`lineChart` / `candlesChart` in `app.js`) |
| File header comments | Every source file opens with its responsibility and key constraints; see `src/binance/live.js` and `src/strategy/liveBook.js` for examples |

Indentation and quotes follow the existing files: 2 spaces, single quotes, trailing semicolons.

---

## 4. Pre-Commit Checklist

Both commands must be **fully green**; neither is optional:

```bash
node scripts/check.js        # 全部 JS 文件语法检查 + 关键文件存在性检查
node --test scripts/*.mjs    # 6 组单元测试，共 64 个用例
```

You can also use `npm run check` / `npm test`. `check.js` runs `node --check` on every `.js` file in the repo and finally prints `检查 JS 文件 N 个，语法错误 M 个。`; any syntax error, or a missing critical file among `server.js`, `package.json`, `src/static/*`, ends with a non-zero exit code.

- [ ] `node scripts/check.js` passes
- [ ] `node --test scripts/*.mjs` is fully green
- [ ] No new third-party dependencies were added
- [ ] `data/`, `master.key`, `*.db` and any API Key are not committed (see section 5)
- [ ] If you changed strategy math, you added the matching unit tests
- [ ] Chinese error messages are readable, and raw internal errors are not thrown straight at users

---

## 5. Security Red Lines (Never Commit These)

| Never commit | Why |
|---|---|
| The entire `data/` directory | Holds the database, the encryption master key and the precision-rule cache |
| `data/master.key` | The AES-256-GCM master key for API Keys — leaking it leaks every key |
| `*.db` / `*.db-shm` / `*.db-wal` | Hold accounts, encrypted keys, orders and positions |
| Any API Key / Secret in plaintext | Including test keys, already-revoked keys, and keys that appear in screenshots |
| Logs and backup archives | `*.log`, `*.tar.gz` — they may carry keys or account information |

`.gitignore` already covers the paths above. **If you commit a key by accident:** ① go to Binance and **delete** that key first (no code fix will save you) →
② then scrub the git history (`git filter-repo` or rebuild the branch) → ③ explain it in the Issue / PR, but **do not paste the key itself**.

---

## 6. Adding a New Test

Tests live under `scripts/`, are named `test-<topic>.mjs`, and use only Node's built-in assertions:
`import test from 'node:test'` + `import assert from 'node:assert/strict'`.
Before writing one, read `scripts/test-minqty.mjs` or `scripts/test-capital.mjs` to confirm the pattern. Key points:

1. **One topic per file.** Open the file with a block comment stating **which bug this test guards against** — every existing test records its root-cause chain;
2. **Test pure functions**: `solver.js`, `params.js`, `engine.js`, `liveBook.js`, `protect.js` under `src/strategy/`
   and `src/binance/protection.js` touch no IO and can be imported directly;
3. **Never make real network requests.** When you need an exchange response, build a fake object of the same shape yourself (`test-precision.mjs` hand-writes an `exchangeInfo` structure — that is the model);
4. **Assertions carry a Chinese message** so a failure shows at a glance where it broke;
5. When fixing a bug, **write a failing test first, then change the code**.

```js
test('requiredQtyUnits 按 minQty/stepSize 算最小台阶数', () => {
  assert.equal(requiredQtyUnits(SKHYNIX), 1, 'minQty 0.01 / step 0.01 → 1 个单位');
  assert.equal(requiredQtyUnits({}), 0, '没有规则时返回 0（不做额外约束）');
});
```

---

## 7. Commit Message Convention

Format `<type>: <one-line summary>`, where the summary is written in Chinese in verb-object form and states what changed:

| Type | Use for |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Refactor with no behavior change |
| `test` | Tests only |
| `chore` | Build, ignore rules, miscellaneous |

```
fix: 止损价被算到强平价外侧时夹回入场价与强平价之间
test: 补 SKHYNIXUSDT 粗步长下的最小下单额回归
```

One commit does one thing. When fixing a bug, put the root cause in the body (`git commit -m "title" -m "body"`).

---

## 8. Pull Request Process

1. **Open an Issue first to state your intent** (bug fixes can go straight to a PR) so you don't finish a large change and discover the direction was wrong;
2. Fork the repository and cut a descriptive branch from `main`: `fix/stop-price-clamp`, `feat/layer-take-profit`;
3. Run the checklist in section 4 locally;
4. Open the PR with a description that covers: **what changed / why** (the root cause, not the symptom), reproduction steps or screenshots,
   the blast radius (if you touched strategy math, explicitly flag the impact on existing bots), and your self-check results;
5. Changes involving strategy math, order quantity or precision normalization **must ship with unit tests**;
6. Changes touching the live order path get an extra review: is idempotency guaranteed, can it mistakenly close a user's manual position, is it protected by a safety gate.

**Changes that will not be merged**: introducing third-party dependencies, bypassing the `LIVE_TRADING` safety gate,
logging API Key / Secret in plaintext, or removing the precision fallback when normalizing precision.

---

## 9. What to Include When Reporting a Bug

| Information | Why it is needed |
|---|---|
| `node -v` and OS version | Anything below 22.5 fails at startup — the most common environment problem |
| Start command and environment variables | Whether `PORT` / `HOST` / `BASE_PATH` / `LIVE_TRADING` / `BINANCE_FEED` were set |
| Full error text | The Chinese message shown in the UI plus the terminal stack trace — **do not paste only half of it** |
| Reproduction steps | Every step from startup to the error: which page, what you clicked, what values you entered |
| Bot parameters | Allocated capital, first-entry share, leverage, add-to-position spacing, layer count, take-profit / stop-loss distance |
| Event log | The event stream on the detail page (`info`/`warn`/`error`/`trade`), which records the basis for every decision |
| Paper mode or live mode | The two use completely different code paths |

**Redact before posting**: remove API Keys, account names, balances, order ids, server addresses and ports from logs and screenshots.
For security issues, **do not open a public Issue** — report it privately as described in [SECURITY.md](SECURITY.en.md).

---

## 10. License

This project is released under the [Apache License 2.0](LICENSE). By opening a PR you agree that your contribution is licensed under the same terms.
