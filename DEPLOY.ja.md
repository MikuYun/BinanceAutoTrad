**日本語** ｜ [中文](DEPLOY.md) ｜ [English](DEPLOY.en.md)

# サーバー配備マニュアル（Ubuntu 22.04 / 24.04）

本プロジェクトを Linux サーバーに配備し、長期間安定して運用するための完全な操作マニュアルです。

> **ローカル**でまず動かしてみたいだけなら、[docs/ja/QUICKSTART.md](docs/ja/QUICKSTART.md) だけで十分です。この文書は不要です。
> 戦略とパラメータを知りたい場合は [docs/ja/STRATEGY.md](docs/ja/STRATEGY.md) を参照してください。

本文の既定パスは `/opt/biance_trae`、システムユーザーは `biance`、ポートは `8787` です。いずれも環境に合わせて置き換えてかまいません。

## 0. プロジェクト早見表

| 項目 | 値 |
| --- | --- |
| ランタイム | 純粋な Node.js で、**サードパーティ依存ゼロ**（`node:` 組み込みモジュールのみ使用） |
| 最低バージョン | Node **>= 22.5**（`node:sqlite` を使用）。Node 24 LTS を推奨 |
| エントリポイント | `node server.js` |
| 静的フロントエンド | `src/static/`。server.js が直接配信 |
| データディレクトリ | `data/`（`app.db`、`master.key`、WAL ファイル） |
| 既定の待受 | `127.0.0.1:8787`。**直接外部に公開する場合は必ず `0.0.0.0` に変更** |
| ライセンス | Apache-2.0 |

環境変数：

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `8787` | 待受ポート |
| `HOST` | `127.0.0.1` | **前面に Nginx リバースプロキシがあるなら既定のまま**。リバースプロキシを挟まず直接公開する場合のみ `0.0.0.0` を設定 |
| `BASE_PATH` | 空 | サブパス配備のプレフィックス。例 `/biance_trae`（詳細は 5.6 節）。空欄＝サイトのルートパス |
| `LIVE_TRADING` | 未設定（＝オフ） | 実弾発注の安全ゲート。`1` を設定した場合のみ実口座への発注を許可 |
| `BT_MASTER_KEY` | 自動生成 | 64 桁の hex。API Key の暗号化に使用。未設定なら `data/master.key` を自動生成 |
| `BINANCE_BASE_URL` | `https://fapi.binance.com` | Binance の USDⓈ-M 無期限先物 REST |
| `BINANCE_TIMEOUT_MS` | `8000` | Binance への通常リクエストのタイムアウト |
| `BINANCE_RECV_WINDOW` | `5000` | 署名の有効ウィンドウ（1000〜60000）。プロキシ経由が遅い場合は大きくする |
| `BINANCE_TIME_SYNC_MS` | `60000` | Binance サーバーとの時刻合わせの更新周期 |
| `TICK_INTERVAL_MS` | `5000` | ボットの tick 間隔 |
| `BINANCE_FEED` | `live` | 相場ソース：`live`＝Binance リアルタイム（既定）、`mock`＝ローカルシミュレーション |
| `NODE_ENV` | なし | `production` を設定してもマーキングのみで、動作は変わりません |

---

## 1. 前提条件

### 1.1 サーバー構成の推奨

- 最小構成：**1 コア 1G**（本プロジェクトの常駐メモリは約 100〜200 MB、SQLite によるローカル読み書き）
- 推奨：1 コア 2G、ディスク 20 GB
- OS：Ubuntu 22.04 LTS または 24.04 LTS

### 1.2 Node 24 のインストール（NodeSource、推奨）

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # 必须 >= v22.5，期望 v24.x
node -e "const {DatabaseSync}=require('node:sqlite');console.log('node:sqlite OK')"
```

> `node:sqlite` でエラーが出る場合は Node のバージョンが低すぎます。22.5 以上にアップグレードする必要があります。

### 1.3 代替：nvm でのインストール（root 権限がない、または複数バージョンが必要な場合）

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
# 注意：nvm 装的 node 路径是 ~/.nvm/versions/node/vXX/bin/node，
# 用 systemd 托管时需要把 ExecStart 里的 /usr/bin/node 换成 `which node` 的结果
```

### 1.4 非 root ユーザー `biance` の作成

```bash
sudo adduser --disabled-password --gecos "" biance
sudo mkdir -p /opt/biance_trae
sudo chown -R biance:biance /opt/biance_trae
```

---

## 2. コードのアップロード

配備先のパスは **`/opt/biance_trae`** に統一します。

### 2.1 方法 A：git clone（推奨）

```bash
sudo -iu biance
cd /opt/biance_trae
# 换成你自己的仓库地址（本项目公开仓库：https://github.com/MikuYun/BinanceAutoTrad）
# /opt/biance_trae 已存在且非空时，用下面这种「克隆到当前目录」的写法
git clone https://github.com/MikuYun/BinanceAutoTrad.git .
```

### 2.2 方法 B：scp でアップロード（git リポジトリがない場合）

**ローカルマシン（Windows PowerShell）** で実行します：

```powershell
# 注意：把 <服务器IP> 和本地项目目录换成实际值
scp -r B:\biance_trae\* biance@<服务器IP>:/opt/biance_trae/
```

アップロード後は、ローカルのデバッグ用データ `data/` を除外します（本番環境に持ち込まないこと）：

```powershell
ssh biance@<服务器IP> "rm -rf /opt/biance_trae/data && mkdir -p /opt/biance_trae/data"
```

---

## 3. インストールと初回起動

```bash
sudo -iu biance
cd /opt/biance_trae

# 本项目零第三方依赖，npm install 只是生成 lockfile，可跳过
npm install --omit=dev || echo "无依赖，跳过亦可"
```

スモークテスト（まずフォアグラウンドで一度起動し、立ち上がることを確認）：

```bash
cd /opt/biance_trae
HOST=0.0.0.0 PORT=8787 node server.js
# 看到监听日志后按 Ctrl+C 停止
```

別のターミナルで検証します：

```bash
curl -I http://127.0.0.1:8787
# 期望返回 HTTP/1.1 200 或 302
```

ブラウザで `http://<サーバーIP>:8787` にアクセスし、ログインページが開けば成功です。

> **注意**：初回起動時に `data/master.key` と `data/app.db` が自動生成されます。
> 続けて、すぐに第 6 節のファイル権限設定を実行してください。

---

## 4. systemd による常駐管理（重要）

### 4.1 unit ファイルの作成

```bash
sudo tee /etc/systemd/system/biance-trae.service > /dev/null <<'EOF'
[Unit]
Description=Binance Quant Terminal (Binance Perp Bot Platform)
Documentation=file:///opt/biance_trae/DEPLOY.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=biance
Group=biance
WorkingDirectory=/opt/biance_trae
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=8787
# Environment=BINANCE_FEED=live
# Environment=BT_MASTER_KEY=<64位hex>   # 选项：不用 data/master.key 时才设
Environment=TICK_INTERVAL_MS=5000
Environment=BINANCE_TIMEOUT_MS=8000
# ⚠️ 实盘下单安全闸：不写这行 = 关闭，实盘机器人无法启动。
# 按住看行情/账户完全不需要它；确定要真钱交易时才取消注释。
# Environment=LIVE_TRADING=1

StandardOutput=journal
StandardError=journal
SyslogIdentifier=biance-trae

# 基础加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/biance_trae/data

[Install]
WantedBy=multi-user.target
EOF
```

> **注意**：`ExecStart` の `/usr/bin/node` は NodeSource でインストールしたパスです。
> nvm でインストールした場合は `which node` の出力（絶対パス）に置き換える必要があります。

### 4.2 起動と自動起動

```bash
sudo systemctl daemon-reload
sudo systemctl enable biance-trae
sudo systemctl start biance-trae
sudo systemctl status biance-trae        # 期望 active (running)
```

### 4.3 よく使う運用コマンド

```bash
sudo systemctl restart biance-trae       # 重启
sudo systemctl stop biance-trae          # 停止
sudo journalctl -u biance-trae -f        # 实时日志
sudo journalctl -u biance-trae -n 200 --no-pager   # 最近 200 行
sudo journalctl -u biance-trae --since "10 min ago" --no-pager
```

---

## 5. HTTPS + リバースプロキシ（重要）

### 5.1 なぜ HTTPS が必要か

ログインには **Cookie セッション**を使用し、Binance の **API Key/Secret もインターフェース経由で送信**されます。
平文 HTTP では、これらが公網を通る際に中間者にそのまま傍受され、取引権限を渡したも同然になります。
**公網への配備では必ず HTTPS を導入**し、TLS は Nginx で終端して、Node はローカルのみを待ち受けさせます。

### 5.2 Nginx と certbot のインストール

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

### 5.3 まず Node を 127.0.0.1 に戻す

```bash
# 有了 Nginx 反代后，Node 不需要对外暴露
sudo sed -i 's/^Environment=HOST=0.0.0.0$/Environment=HOST=127.0.0.1/' \
  /etc/systemd/system/biance-trae.service
sudo systemctl daemon-reload
sudo systemctl restart biance-trae
```

### 5.4 Nginx サイト設定

```bash
sudo tee /etc/nginx/sites-available/biance-trae > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.example.com;   # 注意：换成你的域名

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 预留：以后若加 WebSocket，取消下面两行注释
        # proxy_set_header Upgrade    $http_upgrade;
        # proxy_set_header Connection "upgrade";

        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/biance-trae /etc/nginx/sites-enabled/biance-trae
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

> **説明**：現在のインターフェースはすべて通常の HTTP リクエスト（ポーリングを含む）なので、Nginx の既定の動作で足ります。`Upgrade` ヘッダは**不要**です。
> 将来 WebSocket プッシュを導入するときに初めて、上でコメントアウトしている `Upgrade`/`Connection` の 2 行を有効にする必要があります。有効にしないとハンドシェイクが失敗します。

### 5.5 証明書の取得（certbot が設定を自動変更）

```bash
sudo certbot --nginx -d your-domain.example.com
# 按提示填邮箱、同意协议、选择 "Redirect" 强制跳转 HTTPS
sudo certbot renew --dry-run      # 验证自动续期
```

HTTPS 有効化後は、ブラウザで `https://your-domain.example.com` にアクセスします。
プログラムはリクエストが HTTPS かどうか（直接 TLS、またはリバースプロキシが透過する `X-Forwarded-Proto: https`）に応じて、ログイン Cookie に自動で `Secure` 属性を付与します。
**`Secure` 付きの Cookie は HTTPS 経由でしか送信されません**——これも証明書が必須である理由の一つです。

---

### 5.6 既存サイトのサブパス（`/biance_trae/`）への配備

このサーバーの 80/443 がすでに別のサイトに使われていて（たとえばルートパスで別のサイトが動いている）、
本プロジェクトだけを `http://<ドメインまたはIP>/biance_trae/` の下にぶら下げたい場合は、**既存の server ブロックを書き換えず**、
下記の `location` ブロックを**既存サイトの設定に追記**してください（先頭に置き、`^~` で他の正規表現マッチに横取りされないようにします）。

**ステップ 1：systemd に `BASE_PATH` を追加する（重要）**

```bash
sudo sed -i '/^Environment=PORT=/a Environment=BASE_PATH=/biance_trae' \
  /etc/systemd/system/biance-trae.service
sudo systemctl daemon-reload && sudo systemctl restart biance-trae
```

`BASE_PATH` の役割：バックエンドがリクエストパスの `/biance_trae` プレフィックスを自動的に剥がし（`/biance_trae/api/me` → `/api/me`）、
ログイン Cookie の `Path` を `/biance_trae` に設定します。**異なるサイトの Cookie が互いに上書きされることはなく、同一ドメインの他のサブパスサイトのログイン状態にも影響しません。**

**ステップ 2：nginx に location を追加する（要点：`proxy_pass` の後ろにパスを付けない）**

```nginx
# 追加到已有 server { listen 80; ... } 块内部
location = /biance_trae { return 301 /biance_trae/; }

location ^~ /biance_trae/ {
    proxy_pass http://127.0.0.1:8787;      # 注意：末尾没有 /，保留前缀原样转发
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

> ⚠️ **既存サイトに影響しない前提**：追加するのは `^~ /biance_trae/` のプレフィックス location が 1 つだけです。
> 優先度は通常の location より高いものの、`/biance_trae/` で始まるリクエストにしかマッチしません。
> 同一ドメインの他のあらゆるパス（他のサイトや素の `/api/` を含む）には一行も影響しません。
> 既存設定は**一字も変更不要**で、ロールバックもこのブロックを削除して reload するだけです。
>
> ⚠️ **このマシンにすでに `location ^~ /api/` が存在する場合（多くのサイトが素の `/api/` をバックエンドへリバースプロキシしています）**、
> 本プロジェクトの API を素の `/api/` にぶら下げないでください。2 つのサービスが同じプレフィックスを奪い合います。
> 本プロジェクトの API はすべて `/biance_trae/api/` をプレフィックスとするため、この問題を自然に回避できます。

**ステップ 3：検証**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/biance_trae/          # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/biance_trae/app.js    # 期望 200
curl -s http://127.0.0.1/biance_trae/api/market/health                          # 期望 ok:true
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/                       # 期望和部署前一致
```

ブラウザで `http://<ドメインまたはIP>/biance_trae/` を開けば完了です。末尾の `/` は省略できません。

---

## 6. セキュリティチェックリスト

### 6.1 ファイアウォールは 22/80/443 のみ開放し、8787 を公網に公開しない

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 8787/tcp        # 双保险：即使 Node 绑了 0.0.0.0 也拦掉
sudo ufw enable
sudo ufw status verbose
```

> より確実なのは 5.3 節のように Node を `127.0.0.1` のみにバインドする方法です。そうすれば 8787 は物理的に外部からアクセスできません。

### 6.2 データディレクトリの権限を厳格化する

```bash
sudo chown -R biance:biance /opt/biance_trae/data
sudo chmod 700 /opt/biance_trae/data
sudo chmod 600 /opt/biance_trae/data/master.key
sudo chmod 600 /opt/biance_trae/data/app.db
ls -l /opt/biance_trae/data       # 确认 master.key 是 -rw-------
```

### 6.3 `data/` のバックアップは必須（特に `master.key`）

**`master.key` と `app.db` は必ず一緒にバックアップし、一緒に復元してください。**
`app.db` だけを復元して `master.key` を失うと、DB 内のすべての API Key は復号できない乱碼になります。
`master.key` だけを復元して `app.db` を失うと、ゼロからのやり直しになります。

```bash
sudo apt install -y sqlite3
sudo mkdir -p /root/backup && sudo chmod 700 /root/backup
```

**毎日のバックアップ（crontab。SQLite のオンラインバックアップコマンドを使い、書き込み途中の DB をコピーしないようにします）：**

```bash
sudo tee /usr/local/bin/biance-backup.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SRC=/opt/biance_trae/data
DST=/root/backup
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DST"
sqlite3 "$SRC/app.db" ".backup '$DST/app.db.$STAMP'"
cp -p "$SRC/master.key" "$DST/master.key.$STAMP"
# 保留最近 14 天
find "$DST" -name 'app.db.*'    -mtime +14 -delete
find "$DST" -name 'master.key.*' -mtime +14 -delete
EOF
sudo chmod 700 /usr/local/bin/biance-backup.sh

# 每日 03:30 执行
echo '30 3 * * * root /usr/local/bin/biance-backup.sh' | sudo tee /etc/cron.d/biance-backup
sudo chmod 644 /etc/cron.d/biance-backup
```

**手動での単発バックアップ＋外部への退避：**

```bash
sudo /usr/local/bin/biance-backup.sh
# 从本机（Windows）拉回离线保存，注意 <STAMP> 换成实际时间戳
scp root@<服务器IP>:/root/backup/app.db.* root@<服务器IP>:/root/backup/master.key.* D:\backup\
```

**復元：**

```bash
sudo systemctl stop biance-trae
sudo cp /root/backup/app.db.<STAMP>     /opt/biance_trae/data/app.db
sudo cp /root/backup/master.key.<STAMP> /opt/biance_trae/data/master.key
sudo chown biance:biance /opt/biance_trae/data/*
sudo chmod 600 /opt/biance_trae/data/master.key /opt/biance_trae/data/app.db
sudo rm -f /opt/biance_trae/data/app.db-wal /opt/biance_trae/data/app.db-shm
sudo systemctl start biance-trae
```

### 6.4 Binance API Key の権限を最小化する

Binance の「API 管理」で Key を作成する際は：

- **「読み取りを許可」＋「先物取引を許可」**のみをチェック
- **「出金を許可」は必ずオフ**（オフにしておけば、Key が漏洩しても資産を移せません）
- **サーバーの外向け IP ホワイトリストを必ず紐付ける**：

```bash
# 在服务器上查出口公网 IP，填到币安 API 的 IP 白名单里
curl -s https://api.ipify.org; echo
```

- Key の利用範囲／サブアカウントを制限し、実弾はまず少額資金で検証することを推奨

### 6.5 `data/` を git にコミットしない

```bash
cd /opt/biance_trae
grep -qxF 'data/' .gitignore 2>/dev/null || echo 'data/' >> .gitignore
git rm -r --cached data 2>/dev/null || true
git commit -m "chore: ignore data/" || true
```

---

## 7. アップグレードとロールバック

### 7.1 アップグレード

```bash
cd /opt/biance_trae
sudo /usr/local/bin/biance-backup.sh       # 先备份！
sudo -iu biance git pull
sudo systemctl restart biance-trae
sudo journalctl -u biance-trae -n 50 --no-pager     # 确认启动无报错
```

### 7.2 ロールバック

```bash
cd /opt/biance_trae
git fetch --tags
git tag -l                                  # 查看可用版本
sudo -iu biance git checkout <tag>          # 注意：换成要回滚到的 tag/commit
sudo systemctl restart biance-trae
```

最新版に戻す：`git checkout main`（または `master`）。

> **注意**：新バージョンでデータベース構造が変更されている場合は、ロールバック**前**に必ず `data/` をバックアップしてください。必要に応じて 6.3 節の復元手順で `app.db`＋`master.key` を戻します。

---

## 8. よくあるトラブルの切り分け

### 8.1 ポートが使用中

```bash
ss -lntp | grep 8787
# 找到 pid 后
sudo kill <PID>
sudo systemctl restart biance-trae
```

### 8.2 起動時に `node:sqlite` 非対応／モジュールが見つからないと出る

```
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
```

Node のバージョンが 22.5 未満です。アップグレードします：

```bash
node -v
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo systemctl restart biance-trae
```

### 8.3 ページは開けるが API が 401 を返す

- ブラウザの開発者ツール → Application → Cookies でセッション Cookie の有無を確認
- HTTPS アクセス時は Cookie に `Secure` 属性が付きます（バックエンドが `X-Forwarded-Proto` から自動判定）。**http でアクセスすると付与されません**
- リバースプロキシは `Host`、`X-Forwarded-Proto` を必ず透過してください（5.4 節参照）。そうしないとバックエンドは http 経由と誤認し、Cookie に `Secure` が付かず、一部機能も誤判定します
- サーバーの時刻が正確か確認：`timedatectl status`（時刻のずれはセッション／署名検証の失敗を招きます）
- ブラウザで当該サイトの Cookie を消去してから再ログイン

### 8.4 実弾口座の残高が読めない

項目ごとに切り分けます：

```bash
# 1) 服务器能否访问币安合约域名
curl -s -o /dev/null -w "%{http_code}\n" https://fapi.binance.com/fapi/v1/time
# 期望 200；超时/000 说明网络不通或需代理

# 2) 出口 IP 是否与币安白名单一致
curl -s https://api.ipify.org; echo
```

- Key に「先物取引」権限がない → Binance は `-2015` / `-2014` を返す
- Key に IP ホワイトリストを設定したがサーバーの外向け IP と一致しない → `-2015` Invalid API-key, IP, or permissions
- タイムゾーン／時刻が不正確 → `recvWindow` 超過（本プロジェクトは `recvWindow=5000`）
- 国内でブロックされているドメイン環境を使っている → 利用可能な外向け回線を用意するか自前プロキシを立てて `BINANCE_BASE_URL` を変更

### 8.5 `data/master.key` の紛失／破損

**症状**：ボットは正常に起動するが、API Key 一覧の表示時に復号失敗が出る。旧 Key はすべて使用不可。

```bash
ls -l /opt/biance_trae/data/master.key
sudo journalctl -u biance-trae -n 100 --no-pager | grep -i -E 'decrypt|master|key'
```

**対処**：

1. 権限やファイル削除だけで**バックアップがない**場合：暗号化済みの API Key は**復元できません**。旧 Key を削除して登録し直すしかありません（`master.key` は再生成されます）。
2. 6.3 節のバックアップがある場合：復元手順で `master.key` と `app.db` を**まとめて**戻します。
3. このファイルの紛失を避けたい場合：環境変数 `BT_MASTER_KEY=<64桁hex>` に切り替えて systemd unit に固定します（ただし環境変数は `systemctl show` に表示されるため、ホストの権限に注意）。

---

## 9. オプション：Docker 配備

**Dockerfile（内容のみ記載し、ファイルは作成しない）：**

```dockerfile
FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
RUN mkdir -p /app/data
EXPOSE 8787
VOLUME /app/data
CMD ["node", "server.js"]
```

ビルドと実行：

```bash
cd /opt/biance_trae
docker build -t biance-trae:1.0.0 .

docker run -d --name biance-trae \
  --restart always \
  -p 127.0.0.1:8787:8787 \
  -v /opt/biance_trae/data:/app/data \
  --env TICK_INTERVAL_MS=5000 \
  biance-trae:1.0.0

docker logs -f biance-trae
```

> **注意**：`-v /opt/biance_trae/data:/app/data` は**必ずマウント**してください。
> volume をマウントしない場合、コンテナの再作成／アップグレードで `data/`（`master.key` と `app.db` を含む）がすべて失われ、API Key を復号できなくなります。
> `-p` は `127.0.0.1` のみにバインドし、引き続きホスト側の Nginx でリバースプロキシします。コンテナ構成でも 6.2 節の権限設定はホスト側のデータディレクトリに対して実行してください。

---

## 10. 配備後のセルフチェックリスト

- [ ] `sudo systemctl status biance-trae` が `active (running)` を表示し、`journalctl` にエラーがない
- [ ] ブラウザで `https://<ドメイン>` からログインページを開け、証明書が有効（自己署名の警告が出ない）
- [ ] 登録／ログインが成功し、ページを再読み込みしてもセッションが維持される
- [ ] 相場エリアにリアルタイム価格が表示される（`BINANCE_FEED=mock` の場合はシミュレート価格が動いている）
- [ ] **ペーパーモード**のボットを作成でき、状態が正常に遷移する
- [ ] ペーパーモードの残高を設定でき、数値が正しく表示される
- [ ] `sudo systemctl restart biance-trae` 後に再ログインしても、ユーザー／ボット／注文データが残っている
- [ ] `ss -lntp | grep 8787` が `127.0.0.1:8787` のみの待受を表示し、公網の `http://<IP>:8787` に接続できない
- [ ] `sudo ufw status` で 8787 が deny、22/80/443 のみ allow
- [ ] `ls -l /opt/biance_trae/data` の権限が `700`、`master.key` が `600`
- [ ] バックアップスクリプトを手動で 1 回実行し、`/root/backup/` に `app.db.*` と `master.key.*` が同時に現れる
