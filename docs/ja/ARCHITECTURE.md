**日本語** ｜ [中文](../ARCHITECTURE.md) ｜ [English](../en/ARCHITECTURE.md)

# コードアーキテクチャと読解ガイド

> このコードを読み解きたい人、あるいは実際に手を入れてみたい人に向けたドキュメントです。ここに書かれている結論は、すべてリポジトリ内の実コードに基づいています。

---

## I. プロジェクトの位置づけと技術選定

### 一言でいうと

**サードパーティ依存ゼロ、単一プロセス、Node 組み込みモジュールのみ**で実装した Binance U 本位無期限契約の自動売買プラットフォームです：
バックエンドは最小限の HTTP サーバー + SQLite、フロントエンドは素の JS によるシングルページアプリ、
戦略層は「決め打ちの買い増し + 平均価格での利確」でペーパーモードまたは実弾モードの発注を駆動します。

### なぜこの技術スタックなのか

| 選定 | 実際の状況 | なぜそうしたか |
|---|---|---|
| サードパーティ依存ゼロ | `package.json` に `dependencies` / `devDependencies` がない | トレーディングボットは見知らぬマシンの上で長期間、無人で動き続ける。依存ツリーが大きいほどサプライチェーンリスクが高い。依存ゼロなら「クローン → `node server.js`」が唯一の配備手順になる |
| データベースは `node:sqlite` | `src/db.js` が直接 `import { DatabaseSync } from 'node:sqlite'` | 単一プロセス・単一ユーザーにデータベースサーバーは要らない。ファイル型 SQLite はトランザクションと WAL を備え、バックアップはファイル 1 つのコピーで済む。組み込みモジュールは**ネイティブ拡張のビルドが不要**なので、Windows でもビルドツールを入れなくてよい |
| Python / FastAPI を使わない | フロントとバックが同じ言語 | 戦略層は数値計算が中心で、JS の IEEE-754 倍精度で足りる。さらに重要なのは**フロントとバックが 1 つのパラメータ schema を共有**していること（`PARAM_SCHEMA` がバックエンドの検証とフロントのフォームを同時に駆動する）で、二重定義を丸ごと省ける |
| React / Vue を使わない | `src/static/app.js` は 1655 行の素の ESM | 画面は 6 ビューだけで、仮想 DOM もビルドチェーンも要らない。変更して再読み込みすればすぐ反映され、`npm run build` という工程がない |
| Web フレームワークを入れない | `src/http.js` は 324 行の手書き Router | エンドポイントは全部で 28 個、パスは静的セグメント + `:id` 1 つだけ。手書き Router のほうが、フレームワークのミドルウェア実行順を読み解くより楽 |

**バージョン要件**：`package.json` の `engines.node` は `>=22.5.0` です。`node:sqlite` が Node 22.5 から提供されるためで、これより低いと起動時にそのままエラーになります。実際の推奨は Node 24 LTS です。

---

## II. 全体アーキテクチャ図

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

## III. ディレクトリ構成の項目別解説

### ルートディレクトリ

| ファイル | 役割 |
|---|---|
| `server.js` | エントリーの組み立て：ミドルウェアとルート、相場と時刻同期の起動、前回動いていたボットの復旧、グレースフル終了 |
| `package.json` | スクリプトは `start` / `check` / `test` の 3 つだけで、依存は一切なし |
| `README.md` | 利用者向け：何なのか、どう動かすか、パラメータの調整方法、リスクの注意 |
| `DEPLOY.md` | 運用向け：systemd、Nginx リバースプロキシ、HTTPS、バックアップ、アップグレードとロールバック |
| `LICENSE` | Apache License 2.0 |
| `data/` | 実行時に自動生成され、**git には入れない**：`app.db`、`master.key`、`rules-cache.json` |

### バックエンドの中核

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/config.js` | 108 | 全体設定：`PORT` / `HOST` / `BASE_PATH` / `LIVE_TRADING` / `BT_MASTER_KEY` / `BINANCE` / `PAPER`、および `MASTER_KEY` の読み込みと自動生成 |
| `src/db.js` | 191 | SQLite アクセス層：テーブル作成、インデックス、旧 DB の `ALTER` によるアップグレード、`all` / `get` / `run` / `tx` をエクスポート |
| `src/http.js` | 324 | 最小限の HTTP フレームワーク：`Router`、`HttpError`、body 解析、Cookie、静的ファイル配信、接頭辞の剥離、統一エラー応答 |
| `src/crypto.js` | 124 | AES-256-GCM の暗号化・復号、`maskKey`、scrypt によるパスワードハッシュと `timingSafeEqual` 検証、`randomId`、HMAC-SHA256、SHA-256 |
| `src/auth.js` | 178 | アカウントとセッション：登録、ログイン、`bt_sid` Cookie、ログイン失敗のレート制限、`authMiddleware` |

### ルーティング層 `src/routers/`（5 モジュール、計 28 エンドポイント）

| ファイル | エンドポイント | 役割 |
|---|---|---|
| `auth.js` | 5 | 登録 / ログイン / ログアウト、`GET /api/me`、`GET /api/meta/defaults`（パラメータ schema と銘柄リスト） |
| `robots.js` | 11 | ボットの CRUD、`preview` による試算、start / stop / reset、イベントと注文履歴 |
| `market.js` | 4 | 銘柄リスト、ローソク足、相場概況、接続性のヘルスチェック |
| `account.js` | 4 | 口座概況（paper / live）、口座単位の資産曲線、ペーパーモードのウォレット読み書き |
| `apikeys.js` | 4 | API Key の追加・削除・照会、および Binance API を 1 回呼んでの「検証」 |

### 取引所アダプタ層 `src/binance/`

| ファイル | 行数 | 役割 |
|---|---|---|
| `rest.js` | 423 | Binance REST クライアント：署名、`recvWindow`、時刻オフセットの校正、ハードタイムアウト、冪等なリクエストだけを再試行 |
| `live.js` | 605 | 実弾：精度の丸め、決定的な `clientOrderId`、注文／条件注文／取消、口座読み取り、ルールの 3 段キャッシュ |
| `paper.js` | 266 | ペーパーモードの約定処理：建玉、片側の一括決済、1 筆ごとの決済、資産とスナップショット |
| `liveMarket.js` | 356 | 実弾の相場：バックグラウンドで価格と 24h ticker を定期更新し、同期インターフェースはメモリキャッシュを読むだけ |
| `mockMarket.js` | 248 | オフライン相場：幾何ブラウン運動 + 平均回帰、決定的で再現可能 |
| `index.js` | 71 | 統一エントリー：`getMarketFeed()`、`startMarket()`、`getExchange(mode)`、`loadCredentials(userId)` |
| `protection.js` | 153 | Binance の実際の注文から利確・損切りを識別し、損切りをエントリー価格と強制ロスカット価格の間に挟み込む |

### 戦略層 `src/strategy/`

| ファイル | 行数 | 役割 |
|---|---|---|
| `params.js` | 371 | パラメータ schema、既定値、旧パラメータ名の正規化、パラメータ検証（最小発注額の判定を含む） |
| `solver.js` | 524 | 純粋な数値求解：最小発注可能額、強制ロスカット価格、利確・損切りの目標、買い増しの階段、実行可否の判定 |
| `engine.js` | 259 | 判断の状態機械：「建玉 + 相場 + 計画」を 1 組の `action` に翻訳する |
| `runner.js` | 1087 | オーケストレーター：ボットごとにタイマーを 1 本持ち、相場→帳簿→判断→実行→DB 書き込みをつなぐ |
| `wallet.js` | 243 | ペーパーモードのアカウント単位共有ウォレット：現金は `paper_accounts`、建玉は `robots.paper_json` に記録 |
| `liveBook.js` | 174 | 実弾ボット自身の建玉台帳 `liveLegs`。取引所と突き合わせて、ユーザーの手動ポジションと切り離す |
| `protect.js` | 192 | 保護注文の意図：「どの利確・損切りを置くべきか」を計算し、実際に置かれている注文との差分を取る |
| `accountStats.js` | 250 | 口座単位の資産スナップショット、日次基準、口座の資産曲線と当日の損益 |

### フロントエンドとスクリプト

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/static/index.html` | 46 | シングルページの外枠：ナビゲーション、初回表示時のテーマ復元、マウントポイント |
| `src/static/app.js` | 1655 | フロントのロジックすべて：hash ルーティング、ポーリング、部分更新、schema フォーム、純 SVG のグラフ |
| `src/static/styles.css` | 320 | 4 テーマ（dark / light / blue / warm）の CSS 変数とレイアウト |
| `scripts/check.js` | 52 | 依存ゼロのセルフチェック：全ファイルの `node --check` + 主要ファイルの存在確認 |
| `scripts/test-*.mjs` | 839 | 6 組の単体テスト、64 ケース |

合計は約 **1.05 万行**です。

---

## IV. リクエストのライフサイクル

`POST /api/robots/:id/start` を例にします：

| # | 段階 | 説明 |
|---|---|---|
| ① | `http.createServer` | `src/http.js` がリクエストを受け取り、`new URL(req.url, 'http://localhost')` で pathname と query を取り出す |
| ② | BASE_PATH の剥離 | `/biance_trae` 配下に配備した場合、`/biance_trae/api/...` をまず `/api/...` に剥がす。Cookie の Path にも接頭辞が付く |
| ③ | ctx の組み立て | `{ req, res, params:{}, query, body:{}, user:null, cookies:parseCookies(...) }` |
| ④ | ミドルウェア | 唯一のミドルウェア：`authMiddleware(ctx)` → `bt_sid` からセッションを引き、`ctx.user` を注入 |
| ⑤ | ルートのマッチング | `matchRoute('POST', pathname)`：セグメント数が一致していること、`:id` セグメントは `decodeURIComponent` してから `params` に入れる |
| ⑥ | body の解析 | body を読むのは POST / PATCH / DELETE のみ。1MB を超えると `413 BODY_TOO_LARGE`、JSON でなければ `400 BAD_BODY` を投げる |
| ⑦ | ハンドラー | `routes/robots.js`：`requireAuth` → `ownedRobot(userId, id)`（`WHERE id=? AND user_id=?`、見つからなければ 404、同時に越権も防ぐ）|
| ⑧ | 業務ゲート | live かつ `!TRADING.liveEnabled` → `400 LIVE_DISABLED`；live かつ検証済み Key なし → `400 NO_API_KEY` |
| ⑨ | 副作用 | `UPDATE robots SET status='running'` + `logEvent('机器人启动')`（ボット起動）+ `runner.startRobot(fresh)` |
| ⑩ | 返却 | handler が `undefined` 以外を返し、まだヘッダーを送っていなければ自動で `ok(ctx, 结果)`；`Content-Type` / `Content-Length` / `Cache-Control: no-store` を書き込む |
| ⑪ | 例外 | `HttpError` → `fail(status, code, message)`；それ以外 → `500 INTERNAL_ERROR`。内部の詳細をフロントへ返すことは絶対にしない |

要点は 2 つ：`authMiddleware` は**最初**に登録されるミドルウェアでなければならない；業務エラーはすべて `throw new HttpError(status, CODE, '中文提示')` の形で投げ、フロントは `error.code` で分岐するだけで、`error.message` をそのまま toast に出す。

---

## V. ボットの tick ライフサイクル

`startRobot()` は `setInterval(TICK.intervalMs)` を設定し（既定 **5000ms**、`TICK_INTERVAL_MS` で変更可）、さらに**すぐに** 1 回 tick を実行します。最初の間隔は待ちません。

| # | 手順 | 主な動き |
|---|---|---|
| 1 | 相場の取得 | `feed.getPrice(symbol)` + `feed.atrPctAsync(symbol, params.interval\|\|'1h')`；例外は `warn` イベントを書いて `return` |
| 2 | 価格の検証 | `price > 0` でなければ「当前价格无效，跳过本次决策」（現在価格が無効、今回の判断をスキップ）を書く |
| 3 | ローソク足の取得 | `klinesAsync(symbol, interval, 60)`、失敗時は空配列に降格 |
| 4 | 稼働継続の確認 | `SELECT * FROM robots WHERE id=?` を再検索し、`status !== 'running'` なら `stopRobot` で片付ける |
| 5 | ルールの取得 | `getExchange(mode)`；live は `getLiveRules(symbol)`（10 分キャッシュ）、paper は `PAPER_RULES` |
| 6 | 資金の計算 | paper：`getWallet` + `mergeBook(paper_json, wallet)` で book を組み、`equityOf(book, price)`；live：`loadCredentials` → `fetchAccount` で実際の資産を読み、かつ**必ず** `filterBySymbol(quote.positions, symbol)` する |
| 7 | 実弾の突き合わせ | `parseLiveLegs` + `reconcile(legs, quote.positions)`：多い分は手動ポジション（`info`、スロットル付き）、少なければ比率に応じて台帳を縮小（`warn`） |
| 8 | 資産ゲート | `equity <= 0` → 「权益为 0，无法计算仓位」（資産が 0、ポジションを計算できない）を書いて返す |
| 9 | アンカーの決定 | 建玉あり → `state.anchorPrice` を踏襲；ノーポジション → 現在価格（保有中はトリガー価格が動かない） |
| 10 | 計画の求解 | `decide({...})` の内部で `solvePlan` を呼び、建玉状態に応じて `actions` / `notes` を生成 |
| 11 | 根拠の記録 | `result.notes` を 1 件ずつ `info` イベントとして書き、フロントの詳細ページから直接見えるようにする |
| 12 | アクションなしの分岐 | live でも突き合わせ後の帳簿を `state_json` に書き戻す（そうしないと手動決済の後に帳簿が収束しない）；`recordAccountEquity` → `saveRobot({last_tick})` → `recordEquity`；60 秒ごとに `syncProtection` で取引所側の利確・損切りが残っているか再確認 |
| 13 | アクションの実行 | `actions` を 1 件ずつ処理し、各件の冒頭で `entry.stopped` を確認（ユーザーが停止を押したら即座に手を止める） |
| 14 | ペーパーモードの発注 | まず `availableForUser(userId)` で可用残高を検証し、次に `exchange.openPosition(...)`、失敗は `warn` |
| 15 | 実弾の発注 | **まず安全ゲートを通す**：`if (!TRADING.liveEnabled)` なら「本次只读取行情与账户，不会向币安发送任何订单」（今回は相場と口座を読むだけで、Binance に注文を一切送らない）を書いて `continue`；通った場合のみ `placeOrder` + `addLeg` で記帳 |
| 16 | 決済の記帳 | paper は `closeLegs`（1 筆ごとの利確）/ `closeSide`；live は台帳内の `ownQty` だけを決済し、決済された部分の加重平均価格で `realizedPnl` を計算 |
| 17 | DB への書き込み | `recordOrder` で `orders` を書く；`applyWalletDelta` + `splitBook` でウォレットと `paper_json` を書き戻す；`saveRobot` で `state_json` を更新 |
| 18 | イベントの書き込み | `logEvent` で `events` を書き、フロントのイベントストリームが直接消費する |

再入保護：`entry.ticking` が真なら今回のラウンドはスキップします —— 相場 API が 5 秒より遅くても、判断が 2 本並走することはありません。

---

## VI. 戦略層 4 ファイルの分担

分担の境界は「**誰が IO に触れてよいか**」です：

| ファイル | IO の可否 | 入力 | 出力 | ひとこと |
|---|---|---|---|---|
| `params.js` | 不可 | フロントから渡される生の JSON | 正規化後の完全なパラメータ + 検証結果 | 「ユーザーが何を入力できるか」を定義する |
| `solver.js` | **不可、純粋関数** | `{equity, price, params, rules, anchorPrice, realizedPnl}` | 完全な計画（層数、各層の名目とトリガー価格、平均価格、強制ロスカット価格、利確・損切り価格、実行可否） | 「数学的にどう発注すべきか」を計算する |
| `engine.js` | 不可 | `{params, book, markPrice, equity, rules, quote, anchorPrice, realizedPnl}` | `{ actions, plan, halted, notes }` | 「いま初回を建てる / 買い増す / 利確する / 損切りする / 動かない」を判定する |
| `runner.js` | **可、唯一の IO 出口** | ボット id 1 つ | 副作用：発注、DB 書き込み、イベント書き込み | 5 秒ごとに上の 3 層を 1 周つなぐ |

**`params.js`**：`PARAM_SCHEMA` は 13 項目の配列で、各項目は `{ key, label, group, type, default, options?, min, max, step, help }` を持ち、フロントのフォーム（`renderSchemaForm`）とバックエンドの検証の両方の定義元になります。パラメータを足すときはここ 1 か所を直すだけです。`normalizeParams(raw)` はまず旧パラメータ名を新しい名前に写像し（`k`→`firstPct`、`beta`→`spacingPct`、`kMax`→`totalPct`、`dMax`→`maxLossPct`、`stopAtr`→`stopPct`、`initialCapital`→`allocatedCapital`）、そのうえで schema に従って clamp / ホワイトリストで絞り込み、出力のフィールドが揃うことを保証します。`validateParams(params, {minNotional, minQty, stepSize, price})` は `{ok, errors, warnings, params}` を返します：ハードエラーは「1 筆目の名目が本当の最小発注可能額を下回る」のように結果を計算できない組み合わせ、warning は「損切りの幅が買い増しの間隔より小さい」のように動きはするが良くない組み合わせです。

**`solver.js`**：`fetch` もデータベースも、業務に関わる `Date.now()` も持ちません。だから単体テストから直接呼べます。中核の関数は次のとおりです：

| 関数 | 役割 |
|---|---|
| `requiredQtyUnits` / `qtyUnitsOf` | 「名目金額」を「最小数量ステップ何個分」に換算する |
| `minOrderNotional(price, rules)` | **本当の**最小発注可能名目 = `max(交易所 minNotional, 最小数量 × stepSize × 价格)` |
| `canPlaceNotional(notional, price, rules)` | 上の線を真偽値にしたもの |
| `liqPrice(qty, avgEntry, equity, side)` | クロス証拠金の近似強制ロスカット価格。`equity` は口座の実際の資産でなければならない |
| `tpTargetFor` / `stopTargetFor` / `safeStop` | 利確は**現在の実際の平均価格**で計算し、損切りは `stopPct` で計算したうえでエントリー価格と強制ロスカット価格の間に挟む |
| `solvePlan(input)` | 主エントリー：層数を `maxLayers` から下へ試し、名目上限・損失予算・強制ロスカットより手前の損切り、の 3 つを同時に満たすまで下げる |
| `solveLayers(plan)` | `plan.layerList` を取り出して、フロントの階段表を描く |

**`engine.js`**：状態機械は `IDLE ──建首层──▶ HOLDING ──踩到间距──▶ 加仓 ──▶ FULL ──止盈/止损──▶ IDLE` です。`decide()` の分岐順は固定で、しかも意図があります：まず `sideState` を計算し、次に `solvePlan`、実行不可なら `notes` だけを返します；そのうえで各方向について **ノーポジションなら初回 ＞ 損切り ＞ 利確 ＞ 買い増し**（まず延命、次に利益確定、買い増しは最後）。建玉の前には毎回 2 つのゲートを通します：`canPlaceNotional` と `ownUsedMargin + 新占用 <= capitalBudget` です。

**`runner.js`**：`running` は `Map<robotId, entry>` で、`startRobot` / `stopRobot` / `bootAll` / `shutdownAll` がこれを管理します；`actions` を実際の `placeOrder` / `openPosition` / `closeSide` に翻訳します；`saveRobot` / `recordOrder` / `recordEquity` / `logEvent` の 4 つの書き込み関数はすべて `try/catch` で囲みます —— ログ書き込みの失敗で取引を止めてはならないからです。

---

## VII. 取引所アダプタ層の二重実装

`src/binance/index.js` の選択は 1 行だけです：`mode === 'live' ? liveExchange : paperExchange`。どちらのオブジェクトも `type` フィールドを持ちます。`runner.js` は能力のサブセットしか使いません：

| 呼び出し箇所 | paper の実装 | live の実装 |
|---|---|---|
| 資産の読み取り | `equityOf(book, markPrice)` でローカルに計算 | `fetchAccount(creds)` で取引所から読む |
| 建玉 | `openPosition(book, {...})` でローカルに leg を 1 本足す | `placeOrder(...)` で実際に成行注文を出し、そのあと `addLeg` |
| 決済 | `closeSide` / `closeLegs` でローカルに減算 | `placeOrder(reduceOnly)`、決済された部分の加重平均価格で損益を計算 |
| 精度ルールの取得 | 定数 `PAPER_RULES` | `getRules(symbol)` で `exchangeInfo` を引き、失敗時はディスクのキャッシュへ後退 |

`closeLegs` は両方にあるわけではありません：`runner.js` は `typeof exchange.closeLegs === 'function'` で検出してから 1 筆ごとの利確に進み、なければ片側の一括決済に戻ります。これは意図的な**能力検出**であり、インターフェースによる強制ではありません。

相場側の `liveMarket` と `mockMarket` は**同名同形**のオブジェクトをエクスポートし、`index.js` が `process.env.BINANCE_FEED === 'mock'` で二択します：

| 能力 | `liveMarket` | `mockMarket` |
|---|---|---|
| 同期インターフェース | メモリキャッシュ（`quotes` Map）を読むだけで、イベントループを絶対にブロックしない | ローカルで即時計算、必ず利用できる |
| 非同期インターフェース | `atrPctAsync` / `klinesAsync` は直接ネットワークへ出る | ランダムウォークで OHLCV を生成してから ATR を計算 |
| 更新 | バックグラウンドのタイマー：価格 3s、ticker 30s、銘柄リスト 5min | `tickMarket()` を `server.js` が 3s ごとに 1 回進める |
| 失敗時の挙動 | mock 価格へ降格し `degraded: true` を立てる | 失敗は存在しない |

---

## VIII. データフローと永続化

`app.db` は全部で **10 テーブル**：中核の業務テーブル 7 つ + 補助テーブル 3 つです。

| テーブル | 主キー | 役割 | 書き手 |
|---|---|---|---|
| `users` | `id` | アカウント：ユーザー名、scrypt のパスワードハッシュ、作成日時 | `auth.js` |
| `api_keys` | `id` | 暗号化済みの Key / Secret、マスク値、検証状態と直近のエラー | `routers/apikeys.js` |
| `robots` | `id` | 取引ペア、モード、状態、`params_json`、`state_json`、`paper_json` | `routers/robots.js`、`runner.js` |
| `paper_accounts` | `user_id` | ペーパーモードのアカウント単位共有ウォレット：残高、初期残高、実現損益、累計手数料 | `wallet.js` |
| `orders` | `id`（`client_id` は一意） | 注文履歴：約定平均価格、手数料、`realized_pnl`、`reduce_only` | `recordOrder` |
| `equity_curve` | 自動採番 | **ボット単位**の資産曲線ポイント：時刻、資産、価格、保有数量 | `recordEquity` |
| `events` | 自動採番 | ボットのイベントストリーム（`info`/`warn`/`error`/`trade`）、フロントの詳細ページが直接読む | `logEvent` |
| `sessions` | `id` | ログインセッション：token、ユーザー、有効期限、UA；`purgeExpiredSessions()` が掃除する | `auth.js` |
| `account_equity` | 自動採番 | **アカウント単位**の資産スナップショット、15 秒スロットルで書き込み、直近 5000 件だけ保持 | `accountStats.js` |
| `account_daily` | `(user_id, mode, day)` | 毎日の開始基準。今日の損益 = 現在の資産 − 当日の基準 | `accountStats.js` |

なぜ「ボット単位の `equity_curve`」と「アカウント単位の `account_equity`」の 2 テーブルに分けるのか。ペーパーモードの資金は**アカウント全体で共有するウォレット**なので、ボット単体の曲線はそのボットの分しか表しません。それをそのまま概況の曲線に使うと、ユーザーがウォレット残高を 1 回変えただけで曲線が垂直に落ちますし、元手の桁が大きく違う 2 台のボットが同じ座標系を引き伸ばしてしまい、読み取れなくなります。

### `paper_accounts` と `robots.paper_json` の関係

ここが最も読み違えやすい箇所です：**現金と建玉は別々に保存されます**。

```
paper_accounts（每用户一行，账户级）
  balance / initial_balance / realized_pnl / fee_paid
robots.paper_json（每机器人一份，机器人级）
  positions.long[] / positions.short[] / realizedPnl / feePaid / lastPrice
```

tick のたびに `mergeBook(robotBook, wallet)` で完全な book を組み立てて `paper.js` に渡し、計算が終わったら `splitBook(book)` で分解して別々に DB へ書き戻します。こうするのは Binance のクロス証拠金口座の実際の挙動に近づけるためです：複数のペーパーボットが 1 つの可用残高を共有し、先に証拠金を押さえたほうが取り、足りなければ建玉できません。もしボットごとに残高を 1 つずつ持たせると、「100U あるので 2 台のボットに 100U ずつ配る」が勝手に 200U になってしまいます。

### 実弾モードの永続化はどこにあるのか

実弾モードに「現金」という概念はなく、資産は常に取引所から読みます。`robots.state_json` に保存するのは：`liveLegs`（ボット自身の建玉台帳）、`condOrders`（発注済みの保護注文のスナップショット、差分同期に使う）、`anchorPrice`、`realizedPnl`（次の tick で初めて資金の基数に合流する）、`manualNotice`（手動ポジション通知のスロットル）、`equity` / `balance` / `positions`（直近に読んだ取引所の状態、フロントの描画用）です。

---

## IX. 重要な設計判断（そしてその理由）

**1. 決定的な `clientOrderId` による冪等性**
`makeClientId(robotId, side, layer, action, bucketMs = 300000)` は、ボット id + 方向 + 層番号 + アクション + 5 分の時間バケットから組み立て、乱数は使いません。理由はネットワークタイムアウトという現実の場面です：リクエストは出たが応答が返らず、約定したのかどうか分からない。乱数 id だと次の tick での再送時に**本当にもう 1 ポジション建ててしまいます**；決定的な id なら再送は Binance に重複した `clientOrderId` として拒否され（`-4015` / `-4116`）、そのうえで id から照会し直せば（`recoverByClientId`）1 本目が約定済みだと分かります。同じ理由で `rest.js` は **`GET` と取消の `DELETE` だけを再試行し、注文の `POST` は絶対に自動再試行しません** —— タイムアウトは未約定を意味しないからです。

**2. 実弾専用の建玉台帳 `liveLegs`**
Binance U 本位の両建てでは、同一 symbol のロングは**アカウント単位で集約**されます：`positionRisk` が返すのは「この銘柄にロングが 4.37 枚」という情報だけで、どの何本がボットの建てたものかは区別できません。その塊をそのまま自分のものとして扱えば、ユーザーが手動で建てたポジションをボットが決済してしまいます —— これは実際の資金が飛ぶ事故です。そこで実弾ボットはそれぞれ `state_json.liveLegs` に自分の台帳を持ちます：建玉が成功したら `addLeg`、決済は数量に応じて `drainQty` / `drainLegs`、tick ごとに `reconcile` で突き合わせ —— 取引所側が**多い**分は手動ポジション（通知のみ、絶対に触らない）、**少ない**分は比率に応じて縮小します。台帳は層数・平均価格・決済可能数量の計算にだけ使い、**資産は常に取引所の実際の値**を取ります。

**3. タイムスタンプオフセットの校正**
署名付きリクエストの `timestamp` は `recvWindow` の中に収まっていなければならず、外れると `-1021` が返ります。リバースプロキシを経由すると片道で数百ミリ秒から数秒かかることがあり、ローカルの時計もずれているかもしれません。`rest.js` の `syncTime()` は `/fapi/v1/time` を叩き、**往復の中点**で `timeOffsetMs` を見積もり、以降は一律 `Date.now() + offset` を使います；`startTimeSync()` が 60 秒ごと（`BINANCE_TIME_SYNC_MS`、10s〜600s にクランプ）に再校正します；`-1021` / `-1022` に当たった場合は強制的に再同期してから 1 回だけ再試行します。`recvWindow` の既定は 5000ms で、`BINANCE_RECV_WINDOW` で 1000〜60000 に調整できます。

**4. 精度ルールのキャッシュ `rules-cache.json`**
取引所は数量と価格の両方にステップを要求し、小数 1 桁多いだけで `-1111` になります。しかし `exchangeInfo` の応答は約 1.1MB、契約が千個以上あり、注文のたびに引くわけにはいきません。`live.js` は 3 段構えにします：メモリの `Map`（TTL 10 分）→ ディスクの `data/rules-cache.json`（0600）→ 最後の砦として `HARDCODED_RULES` に `degraded: true` を立てる。**降格したルールはキャッシュしません**。一度のネットワークの揺らぎが誤った精度を固定化してしまうからです。発注時にもう 1 段あります：`precisionAttempts()` が数量とトリガー価格の精度を同時に 1 段ずつ落とし（最大 4 段）、各段で最小名目を満たす必要があり、`-1111` に当たったら次の段で送り直します。`parseFilters()` は `LOT_SIZE` と `MARKET_LOT_SIZE` のうち**粗いほう**のステップを取ります。成行注文は `MARKET_LOT_SIZE` で検証されるためです。

**5. `LIVE_TRADING` 安全ゲート**
`config.js` には `export const TRADING = { liveEnabled: process.env.LIVE_TRADING === '1' }` の 1 行しかありませんが、3 か所のチェックで多層防御を構成しています：`routers/robots.js` の start が起動を拒否し（`400 LIVE_DISABLED`）；`runner.js` が発注前に実弾の注文 1 件ずつを止めて `warn` を書く；実弾の tick は通常どおり相場と口座を読むので、ページのデータは生きています。既定は**オフ**で、開くには起動コマンドに明示的に `LIVE_TRADING=1` を付ける必要があり、再起動すればオフに戻ります。

**6. 価格アンカー `anchorPrice`**
`anchorPrice` は**ノーポジションのとき**にその時点の約定価格を取り、保有中はずっとそれを踏襲し、完全に決済して初めて取り直します。アンカーを固定しないと、トリガー価格がリアルタイム価格に合わせて滑ります：価格が下がれば買い増しラインも一緒に下がり、**いつまでも買い増しが来ません**；上がれば利確目標も一緒に漂い、利確に永遠に届きません。固定すれば第 N 層のトリガー価格は建玉した瞬間に確定し、挙動は再現可能で単体テストもできます（`test-capital.mjs` には「同じ `anchorPrice` から生成される階段が完全に一致する」というケースがあります）。

---

## X. テストとセルフチェック

**`node scripts/check.js`**（52 行、依存ゼロ）は 2 つのことをします：再帰的な `walk(ROOT)` で `.js` をすべて集め（`node_modules`、`data`、`.git` はスキップ）、1 つずつ `spawnSync(process.execPath, ['--check', file])` で構文だけを検査して実行はしない；次に主要ファイルの存在を確認する（`server.js`、`package.json`、`src/static/index.html`、`src/static/app.js`、`src/static/styles.css`）。出力は `检查 JS 文件 N 个，语法错误 M 个。`（JS ファイル N 個を検査、構文エラー M 個）、どれか 1 つでも失敗すれば `process.exitCode = 1`、全部通れば `✅ 全部通过`（すべて合格）を表示します。

**6 組の単体テスト**はすべて `node:test` + `node:assert/strict` で書き、テストフレームワークへの依存はありません。合計 **64 ケース**です：

| ファイル | ケース | 何をテストするか |
|---|---|---|
| `test-capital.mjs` | 10 | 建玉は口座資産ではなく `allocatedCapital` で計算される；資金が小さすぎれば実行不可と判定する；買い増しの累計占用が予算を超えない；間隔まで下がって初めて買い増し、平均価格が薄まる；アンカー固定時に階段が一致する；資金の基数 = 割当資金 + 実現損益；損し切った後は 0 のままでマイナスにならない；利益が基数に合流すると階段も同期して拡大する；`decide` が `realizedPnl` を透過する |
| `test-minqty.mjs` | 8 | 「名目は足りるが数量が最小ステップ 1 個に届かない」境界：`requiredQtyUnits` / `qtyUnitsOf` / `minOrderNotional` / `canPlaceNotional`；ステップの粗い銘柄では実行不可と判定して中国語のヒントを出す；ちょうど 1 ステップなら実行可能；BTC は依然として名目のしきい値が支配する；`decide` は資金不足なら発注しない |
| `test-precision.mjs` | 12 | 精度ルール：株式型の無期限（`TRADIFI_PERPETUAL`）は取引可能として扱わなければならない；受渡と取引停止の除外；`parseFilters` が実際のフィルターを解析する；`MARKET_LOT_SIZE` のほうが粗ければ粗いほうを採り、なければ `LOT_SIZE` に戻る；精度を落とす候補は名目がまだ足りるときだけ提示する；条件注文の数量とトリガー価格を同時に精度ダウンする；`fmtPrice` は `tickSize` で四捨五入する；`stepSize=1` なら整数化；指数表記のステップ |
| `test-protect.mjs` | 10 | 保護注文の意図：`avg` モードでは片側 1 対、`layer` モードでは 1 筆ごとに利確が 1 つで損切りは 1 つだけ、空売りは方向が逆、損切りはエントリーと強制ロスカットの間に挟まる、名目不足は `skipped` に入る、ノーポジションなら注文を出さない、`diffCondOrders` は同じ id なら再送しない / トリガー価格が変われば旧を消して新を出す / 取引所から消えたものは掃除する、`normalizeCondOrders` は 2 種類の過去構造を許容する |
| `test-protection.mjs` | 6 | Binance の**実際の注文**から利確・損切りの方向の意味を識別する；注文がなければ `source='none'` で価格は 0 を返す（プラットフォームが勝手に価格を作ってはいけない）；`clampStopToLiq` が逆側にはみ出した損切りを引き戻す |
| `test-livebook.mjs` | 10 | `liveLegs` 台帳：累加と加重平均価格、汚いデータは記帳しない、三者突き合わせ（多い→手動ポジション / 少ない→比率で縮小 / 全部決済→クリア）、数量で減算しても平均価格は変わらない、1 筆ごとの決済は指定した数筆だけを減らす、`bookOf` の構造、`parseLiveLegs` の寛容さ、`filterBySymbol` がこの取引ペアだけを残す |

```bash
node scripts/check.js        # 语法自检
node --test scripts/*.mjs    # 全部单元测试
```

`npm run check` / `npm test` でも構いません。

---

## XI. 二次開発ガイド

### 新しい戦略を追加する

**方法 A：アルゴリズムだけを差し替え、スケジューリングと永続化は再利用する（推奨）**

| 触るファイル | どう触るか |
|---|---|
| `src/strategy/solver.js` | 新しい求解関数を足し、同じ形の計画オブジェクトを返す（少なくとも `feasible` / `layers` / `layerList` / `tpPrice` / `stopPrice` を含む） |
| `src/strategy/engine.js` | `decide()` の中でパラメータに応じて別の求解関数へ振り分ける。`actions` の構造は変えない |
| `src/strategy/params.js` | `PARAM_SCHEMA` にパラメータを足す（フロントのフォームに自動で現れる）。`normalizeParams` にフォールバックを補う |
| `src/strategy/runner.js` | **通常は変更不要** —— `actions` の取り決めたフィールドを消費するだけ |

`actions` の取り決めは `{ type:'open'|'close', side:'long'|'short', layer, notional, price, reason, legIds? }` です。生成される `actions` がこの形を満たしていれば、実行・記帳・DB 書き込み・イベント書き込みは一切変更せずに済みます。

**方法 B：スケジューラーを新設する**。新しい戦略のリズムが「5 秒ごとに確認する」ではない場合（たとえばイベント駆動）、`runner.js` のインターフェースに倣って別モジュールを書き、`startRobot` / `stopRobot` / `isRunning` / `bootAll` / `shutdownAll` を実装し、`server.js` と `routers/robots.js` で `robot.strategy` フィールドに応じて振り分けます。`robots` テーブルに列を 1 つ足すだけでよく、`db.js` には「列の存在を確認してから `ALTER TABLE`」というアップグレードの書き方がすでにあり、そのまま真似できます。

### 別の取引所につなぐ

触るのはアダプタ層だけで、**戦略層は 1 行も変えません**：

| 手順 | ファイル | 説明 |
|---|---|---|
| 1 | `src/binance/<exchange>.js` を新規作成 | exchange オブジェクトを実装：`type`、`fetchAccount`（live 側）/ `equityOf`（paper 側）、`openPosition` / `placeOrder`、`closeSide`、`getRules` |
| 2 | `src/binance/<exchange>Market.js` を新規作成 | 相場の供給元。`liveMarket` / `mockMarket` と同名同形のオブジェクトをエクスポート：`getPrice` / `ticker` / `atrPct` / `klines` / `funding` / `symbols` / `ping` / `health`、非同期版には `*Async` を付ける |
| 3 | `src/binance/index.js` を変更 | `getMarketFeed()` と `getExchange()` に分岐を足す；`loadCredentials` もフィールドが違えば合わせて変更する |
| 4 | `<exchange>Protection.js` を新規作成（必要な場合） | `src/binance/protection.js` の形に倣う：`protectionFromOrders(orders, {symbol, side, markPrice})` |
| 5 | テストを追加 | `scripts/` に `test-<exchange>.mjs` を足し、偽データで精度の丸めと冪等 id をテストする。単体テストの中で**実際のリクエストを送ってはいけない** |

取引所を替えると、まず間違いなく書き直しになる意味が 3 つあります：**精度ルール**（`parseFilters` / `precisionAttempts` は Binance の `exchangeInfo` の形に依存している）、**冪等の仕組み**（取引所がクライアント注文 id による重複排除に対応していることが前提）、**建玉モード**（`liveLegs` の前提は「取引所が symbol + 方向で建玉を集約する」こと。新しい取引所が注文単位で建玉を区別できるなら、この層は簡略化できます）。

### HTTP エンドポイントを追加する

1. 対応する `src/routers/*.js` に `app.get/post/...` を足す。パスには**`/api` を付けない**（フレームワークが `/api` で振り分けるので、実際には `/robots/:id/xxx` と書く）；
2. 業務エラーは統一して `throw new HttpError(4xx, 'CODE', '中文提示')`；
3. 普通のオブジェクトを返せばよく、フレームワークが自動で `{ ok: true, data }` に包む；
4. リソースの帰属が関わるものは必ず先に `ownedRobot(userId, id)` を通す。`WHERE id=? AND user_id=?` が照会と越権防止を同時に果たす。

---

## XII. さらに読む

| 何を知りたいか | どこを見るか |
|---|---|
| 使い方、画面の操作方法 | [README.ja.md](../../README.ja.md) |
| 13 個のパラメータそれぞれの数学的な意味 | [STRATEGY.md](STRATEGY.md) |
| サーバーへの配備、systemd、HTTPS | [DEPLOY.ja.md](../../DEPLOY.ja.md) |
| セキュリティ方針と脆弱性の報告 | [SECURITY.ja.md](../../SECURITY.ja.md) |
| コードへの貢献方法 | [CONTRIBUTING.ja.md](../../CONTRIBUTING.ja.md) |
