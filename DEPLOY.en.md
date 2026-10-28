**English** ｜ [中文](DEPLOY.md) ｜ [日本語](DEPLOY.ja.md)

# Server Deployment Manual (Ubuntu 22.04 / 24.04)

A complete operations manual for deploying this project to a Linux server and keeping it running reliably over the long term.

> Just want to get it running **locally** first to have a look? [docs/en/QUICKSTART.md](docs/en/QUICKSTART.md) is all you need; this document is not required.
> Want to understand the strategy and parameters? See [docs/en/STRATEGY.md](docs/en/STRATEGY.md).

The paths in this document default to `/opt/biance_trae`, the system user to `biance`, and the port to `8787`; all of them can be replaced to suit your environment.

## 0. Project Facts at a Glance

| Item | Value |
| --- | --- |
| Runtime | Pure Node.js, **zero third-party dependencies** (only `node:` built-in modules) |
| Minimum version | Node **>= 22.5** (uses `node:sqlite`); Node 24 LTS recommended |
| Entry point | `node server.js` |
| Static frontend | `src/static/`, served directly by server.js |
| Data directory | `data/` (`app.db`, `master.key`, WAL files) |
| Default listener | `127.0.0.1:8787`; **must be changed to `0.0.0.0` when serving the internet directly** |
| License | Apache-2.0 |

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Listening port |
| `HOST` | `127.0.0.1` | **Keep the default when Nginx sits in front as a reverse proxy**; set `0.0.0.0` only when the service is exposed directly without a proxy |
| `BASE_PATH` | empty | Sub-path deployment prefix, e.g. `/biance_trae` (see section 5.6); empty = site root |
| `LIVE_TRADING` | unset (= off) | Live-order safety interlock; orders can only reach a real account when it is set to `1` |
| `BT_MASTER_KEY` | auto-generated | 64-char hex used to encrypt API keys; if unset, `data/master.key` is generated automatically |
| `BINANCE_BASE_URL` | `https://fapi.binance.com` | Binance USDⓈ-M futures REST |
| `BINANCE_TIMEOUT_MS` | `8000` | Timeout for ordinary Binance requests |
| `BINANCE_RECV_WINDOW` | `5000` | Signature validity window (1000~60000); increase it when the proxy path is slow |
| `BINANCE_TIME_SYNC_MS` | `60000` | Refresh interval for clock sync with Binance servers |
| `TICK_INTERVAL_MS` | `5000` | Bot tick interval |
| `BINANCE_FEED` | `live` | Market data source: `live` = Binance real-time (default), `mock` = local simulation |
| `NODE_ENV` | none | Setting `production` is only a marker; it does not change behavior |

---

## 1. Prerequisites

### 1.1 Recommended server specs

- Minimum: **1 core / 1 GB** (this project uses roughly 100–200 MB resident memory, with local SQLite reads and writes)
- Recommended: 1 core / 2 GB, 20 GB disk
- OS: Ubuntu 22.04 LTS or 24.04 LTS

### 1.2 Install Node 24 (NodeSource, recommended)

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # 必须 >= v22.5，期望 v24.x
node -e "const {DatabaseSync}=require('node:sqlite');console.log('node:sqlite OK')"
```

> If `node:sqlite` throws an error, your Node version is too old and must be upgraded to 22.5+.

### 1.3 Alternative: install with nvm (no root, or when you need multiple versions)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
# 注意：nvm 装的 node 路径是 ~/.nvm/versions/node/vXX/bin/node，
# 用 systemd 托管时需要把 ExecStart 里的 /usr/bin/node 换成 `which node` 的结果
```

### 1.4 Create a non-root user `biance`

```bash
sudo adduser --disabled-password --gecos "" biance
sudo mkdir -p /opt/biance_trae
sudo chown -R biance:biance /opt/biance_trae
```

---

## 2. Upload the Code

The target path is **`/opt/biance_trae`** throughout.

### 2.1 Option A: git clone (recommended)

```bash
sudo -iu biance
cd /opt/biance_trae
# 换成你自己的仓库地址（本项目公开仓库：https://github.com/MikuYun/BinanceAutoTrad）
# /opt/biance_trae 已存在且非空时，用下面这种「克隆到当前目录」的写法
git clone https://github.com/MikuYun/BinanceAutoTrad.git .
```

### 2.2 Option B: upload with scp (when there is no git repository)

Run this on the **local machine (Windows PowerShell)**:

```powershell
# 注意：把 <服务器IP> 和本地项目目录换成实际值
scp -r B:\biance_trae\* biance@<服务器IP>:/opt/biance_trae/
```

After uploading, exclude the local debug data `data/` (do not carry it into production):

```powershell
ssh biance@<服务器IP> "rm -rf /opt/biance_trae/data && mkdir -p /opt/biance_trae/data"
```

---

## 3. Installation and First Start

```bash
sudo -iu biance
cd /opt/biance_trae

# 本项目零第三方依赖，npm install 只是生成 lockfile，可跳过
npm install --omit=dev || echo "无依赖，跳过亦可"
```

Smoke test (run it once in the foreground to confirm it comes up):

```bash
cd /opt/biance_trae
HOST=0.0.0.0 PORT=8787 node server.js
# 看到监听日志后按 Ctrl+C 停止
```

Open another terminal and verify:

```bash
curl -I http://127.0.0.1:8787
# 期望返回 HTTP/1.1 200 或 302
```

Browsing to `http://<server-IP>:8787` and seeing the login page means you are good to go.

> **Note**: the first start automatically generates `data/master.key` and `data/app.db`.
> Immediately afterwards, carry out the file permission setup in section 6.

---

## 4. Running under systemd (important)

### 4.1 Create the unit file

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

> **Note**: `/usr/bin/node` in `ExecStart` is the path installed by NodeSource.
> If Node was installed with nvm, you must replace it with the output of `which node` (an absolute path).

### 4.2 Start and enable at boot

```bash
sudo systemctl daemon-reload
sudo systemctl enable biance-trae
sudo systemctl start biance-trae
sudo systemctl status biance-trae        # 期望 active (running)
```

### 4.3 Common operations commands

```bash
sudo systemctl restart biance-trae       # 重启
sudo systemctl stop biance-trae          # 停止
sudo journalctl -u biance-trae -f        # 实时日志
sudo journalctl -u biance-trae -n 200 --no-pager   # 最近 200 行
sudo journalctl -u biance-trae --since "10 min ago" --no-pager
```

---

## 5. HTTPS + Reverse Proxy (important)

### 5.1 Why HTTPS

Login uses **cookie-based sessions**, and the Binance **API key/secret are also submitted through the API**.
Over plaintext HTTP, that traffic crosses the public internet and a man-in-the-middle can intercept it outright — effectively handing over trading authority.
**Any public deployment must use HTTPS**, with Nginx terminating TLS and Node listening only on localhost.

### 5.2 Install Nginx and certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

### 5.3 First pull Node back to 127.0.0.1

```bash
# 有了 Nginx 反代后，Node 不需要对外暴露
sudo sed -i 's/^Environment=HOST=0.0.0.0$/Environment=HOST=127.0.0.1/' \
  /etc/systemd/system/biance-trae.service
sudo systemctl daemon-reload
sudo systemctl restart biance-trae
```

### 5.4 Nginx site configuration

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

> **Note**: every current endpoint is an ordinary HTTP request (polling included), so Nginx's default behavior is sufficient and the `Upgrade` header is **not** needed.
> Only when WebSocket push is introduced later must the two commented-out `Upgrade`/`Connection` lines above be enabled, otherwise the handshake will fail.

### 5.5 Obtain a certificate (certbot rewrites the configuration for you)

```bash
sudo certbot --nginx -d your-domain.example.com
# 按提示填邮箱、同意协议、选择 "Redirect" 强制跳转 HTTPS
sudo certbot renew --dry-run      # 验证自动续期
```

Once HTTPS is in effect, browse to `https://your-domain.example.com`.
Depending on whether the request arrived over HTTPS (direct TLS, or `X-Forwarded-Proto: https` passed through by the reverse proxy), the application automatically adds the `Secure` attribute to the login cookie.
**A cookie with Secure can only be issued over HTTPS** — which is one of the reasons a certificate is mandatory.

---

### 5.6 Deploying under a sub-path of an existing site (`/biance_trae/`)

If ports 80/443 on this server are already used by another site (for example, a site already running at the root path) and you only want to mount this project at `http://<domain-or-IP>/biance_trae/`, **do not touch the existing server block**; instead **append the `location` block below to the existing site configuration** (put it first, and let `^~` prevent other regex locations from stealing the match).

**Step 1: add `BASE_PATH` to systemd (important)**

```bash
sudo sed -i '/^Environment=PORT=/a Environment=BASE_PATH=/biance_trae' \
  /etc/systemd/system/biance-trae.service
sudo systemctl daemon-reload && sudo systemctl restart biance-trae
```

What `BASE_PATH` does: the backend automatically strips the `/biance_trae` prefix from request paths (`/biance_trae/api/me` → `/api/me`) and sets the login cookie's `Path` to `/biance_trae`. **Cookies from different sites will not overwrite each other, and the login state of other sub-path sites on the same domain is unaffected.**

**Step 2: append the location in nginx (crucial: no path after `proxy_pass`)**

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

> ⚠️ **Why existing sites are unaffected**: the only addition is one `^~ /biance_trae/` prefix location.
> Although its priority is higher than ordinary locations, it only matches requests beginning with `/biance_trae/`
> and does not affect a single line of any other path on the same domain (including other sites and a bare `/api/`).
> The existing configuration **needs not one character changed**, and rolling back only requires deleting this block and reloading.
>
> ⚠️ **If `location ^~ /api/` already exists on this machine (many sites reverse-proxy the bare `/api/` to a backend)**,
> never mount this project's API under the bare `/api/`, or the two services will fight over the same prefix.
> Every endpoint in this project is prefixed with `/biance_trae/api/`, which naturally avoids the problem.

**Step 3: verify**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/biance_trae/          # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/biance_trae/app.js    # 期望 200
curl -s http://127.0.0.1/biance_trae/api/market/health                          # 期望 ok:true
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/                       # 期望和部署前一致
```

Open `http://<domain-or-IP>/biance_trae/` in a browser. Note that the trailing `/` cannot be omitted.

---

## 6. Security Checklist

### 6.1 Firewall: open only 22/80/443, keep 8787 off the public internet

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

> The safer approach is section 5.3 — bind Node to `127.0.0.1` only, in which case 8787 is physically unreachable from outside.

### 6.2 Tighten data directory permissions

```bash
sudo chown -R biance:biance /opt/biance_trae/data
sudo chmod 700 /opt/biance_trae/data
sudo chmod 600 /opt/biance_trae/data/master.key
sudo chmod 600 /opt/biance_trae/data/app.db
ls -l /opt/biance_trae/data       # 确认 master.key 是 -rw-------
```

### 6.3 Backing up `data/` is mandatory (especially `master.key`)

**`master.key` and `app.db` must be backed up together and restored together.**
Restore only `app.db` and lose `master.key`, and every API key in the database becomes undecryptable garbage;
restore only `master.key` and lose `app.db`, and you are starting from zero.

```bash
sudo apt install -y sqlite3
sudo mkdir -p /root/backup && sudo chmod 700 /root/backup
```

**Daily backup (crontab, using the SQLite online backup command so you never copy a half-written database):**

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

**One-off manual backup + pull it off-site:**

```bash
sudo /usr/local/bin/biance-backup.sh
# 从本机（Windows）拉回离线保存，注意 <STAMP> 换成实际时间戳
scp root@<服务器IP>:/root/backup/app.db.* root@<服务器IP>:/root/backup/master.key.* D:\backup\
```

**Restore:**

```bash
sudo systemctl stop biance-trae
sudo cp /root/backup/app.db.<STAMP>     /opt/biance_trae/data/app.db
sudo cp /root/backup/master.key.<STAMP> /opt/biance_trae/data/master.key
sudo chown biance:biance /opt/biance_trae/data/*
sudo chmod 600 /opt/biance_trae/data/master.key /opt/biance_trae/data/app.db
sudo rm -f /opt/biance_trae/data/app.db-wal /opt/biance_trae/data/app.db-shm
sudo systemctl start biance-trae
```

### 6.4 Minimize Binance API key permissions

When creating a key under Binance "API Management":

- Tick only **"Enable Reading" + "Enable Futures Trading"**
- **"Enable Withdrawals" must stay off** (with it off, even a leaked key cannot move assets out)
- **Bind the server's egress IP whitelist**:

```bash
# 在服务器上查出口公网 IP，填到币安 API 的 IP 白名单里
curl -s https://api.ipify.org; echo
```

- Consider limiting the key's scope/sub-account, and validate live trading with a small amount of capital first

### 6.5 Do not commit `data/` to git

```bash
cd /opt/biance_trae
grep -qxF 'data/' .gitignore 2>/dev/null || echo 'data/' >> .gitignore
git rm -r --cached data 2>/dev/null || true
git commit -m "chore: ignore data/" || true
```

---

## 7. Upgrade and Rollback

### 7.1 Upgrade

```bash
cd /opt/biance_trae
sudo /usr/local/bin/biance-backup.sh       # 先备份！
sudo -iu biance git pull
sudo systemctl restart biance-trae
sudo journalctl -u biance-trae -n 50 --no-pager     # 确认启动无报错
```

### 7.2 Rollback

```bash
cd /opt/biance_trae
git fetch --tags
git tag -l                                  # 查看可用版本
sudo -iu biance git checkout <tag>          # 注意：换成要回滚到的 tag/commit
sudo systemctl restart biance-trae
```

To return to the latest version: `git checkout main` (or `master`).

> **Note**: if the new version changed the database schema, you must back up `data/` **before** rolling back; if necessary, use the restore procedure in section 6.3 to bring back `app.db` + `master.key`.

---

## 8. Troubleshooting

### 8.1 Port already in use

```bash
ss -lntp | grep 8787
# 找到 pid 后
sudo kill <PID>
sudo systemctl restart biance-trae
```

### 8.2 Startup reports `node:sqlite` unsupported / module not found

```
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
```

Your Node version is below 22.5. Upgrade:

```bash
node -v
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo systemctl restart biance-trae
```

### 8.3 The page loads but the API returns 401

- Browser dev tools → Application → Cookies: check whether the session cookie exists
- Under HTTPS the cookie carries the `Secure` attribute (the backend decides based on `X-Forwarded-Proto`); **over http it will not be set**
- The reverse proxy must pass through `Host` and `X-Forwarded-Proto` (see 5.4), otherwise the backend believes you are on http, the cookie has no `Secure`, and some features will misjudge the situation as well
- Check that the server clock is accurate: `timedatectl status` (clock drift causes session and signature validation failures)
- Clear the site's cookies in the browser and log in again

### 8.4 The live account cannot read its balance

Work through the items one by one:

```bash
# 1) 服务器能否访问币安合约域名
curl -s -o /dev/null -w "%{http_code}\n" https://fapi.binance.com/fapi/v1/time
# 期望 200；超时/000 说明网络不通或需代理

# 2) 出口 IP 是否与币安白名单一致
curl -s https://api.ipify.org; echo
```

- The key lacks the "Futures Trading" permission → Binance returns `-2015` / `-2014`
- The key has an IP whitelist bound but it does not match the server's egress IP → `-2015` Invalid API-key, IP, or permissions
- Timezone/clock is inaccurate → `recvWindow` exceeded (this project uses `recvWindow=5000`)
- You are in an environment where the domain is blocked domestically → configure a usable egress or a self-hosted proxy, then change `BINANCE_BASE_URL`

### 8.5 `data/master.key` lost or corrupted

**Symptom**: the bot starts normally, but listing API keys reports decryption failures; all old keys are unusable.

```bash
ls -l /opt/biance_trae/data/master.key
sudo journalctl -u biance-trae -n 100 --no-pager | grep -i -E 'decrypt|master|key'
```

**What to do**:

1. If it is only a permissions problem or the file was deleted and there is **no backup**: the already-encrypted API keys **cannot be recovered**; you can only delete the old keys and enter them again (`master.key` will be regenerated).
2. If you have the backup from section 6.3: follow the restore procedure to bring back `master.key` and `app.db` **together**.
3. To avoid losing this file: switch to the environment variable `BT_MASTER_KEY=<64-char hex>` and persist it in the systemd unit (but environment variables show up in `systemctl show`, so mind host permissions).

---

## 9. Optional: Docker Deployment

**Dockerfile (content only; create the file yourself):**

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

Build and run:

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

> **Note**: `-v /opt/biance_trae/data:/app/data` **must be mounted**.
> Without the volume mount, rebuilding or upgrading the container loses everything under `data/` (including `master.key` and `app.db`), and the API keys can no longer be decrypted.
> `-p` binds only to `127.0.0.1`, leaving the reverse proxying to the host Nginx. Under the container approach, the permission settings in section 6.2 still have to be applied to the host data directory.

---

## 10. Post-Deployment Self-Check Checklist

- [ ] `sudo systemctl status biance-trae` shows `active (running)`, and `journalctl` reports no errors
- [ ] The login page opens at `https://<domain>` with a valid certificate (no self-signed warning)
- [ ] Registration/sign-in succeeds, and the session survives a page refresh
- [ ] The market section shows live prices (with `BINANCE_FEED=mock`, simulated prices are ticking)
- [ ] A **paper-trading** bot can be created and its status transitions correctly
- [ ] The paper-trading balance can be set and displays the correct value
- [ ] After `sudo systemctl restart biance-trae` and logging in again, the user/bot/order data is still there
- [ ] `ss -lntp | grep 8787` shows a listener only on `127.0.0.1:8787`, and the public `http://<IP>:8787` is unreachable
- [ ] In `sudo ufw status`, 8787 is denied and only 22/80/443 are allowed
- [ ] `ls -l /opt/biance_trae/data` shows permissions `700`, with `master.key` at `600`
- [ ] Running the backup script manually produces both `app.db.*` and `master.key.*` under `/root/backup/`
