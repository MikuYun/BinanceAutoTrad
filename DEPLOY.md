# 服务器部署手册（Ubuntu 22.04 / 24.04）

把本项目部署到一台 Linux 服务器上并长期稳定运行的完整操作手册。

> 只想在**本机**先跑起来看看？看 [docs/QUICKSTART.md](docs/QUICKSTART.md) 就够了，不需要这份文档。
> 想了解策略与参数？看 [docs/STRATEGY.md](docs/STRATEGY.md)。

本文默认路径为 `/opt/biance_trae`、系统用户为 `biance`、端口 `8787`，都可根据你的环境替换。

## 0. 项目事实速查

| 项 | 值 |
| --- | --- |
| 运行时 | 纯 Node.js，**零第三方依赖**（只用 `node:` 内置模块） |
| 最低版本 | Node **>= 22.5**（用了 `node:sqlite`），推荐 Node 24 LTS |
| 入口 | `node server.js` |
| 静态前端 | `src/static/`，由 server.js 直接托管 |
| 数据目录 | `data/`（`app.db`、`master.key`、WAL 文件） |
| 默认监听 | `127.0.0.1:8787`，**直接对外服务时必须改成 `0.0.0.0`** |
| 许可证 | Apache-2.0 |

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | **前面有 Nginx 反代就保持默认**；不走反代直接对外才设 `0.0.0.0` |
| `BASE_PATH` | 空 | 子路径部署前缀，如 `/biance_trae`（详见 5.6 节），留空=站点根路径 |
| `LIVE_TRADING` | 未设置（=关） | 实盘下单安全闸，设 `1` 才允许向真实账户发单 |
| `BT_MASTER_KEY` | 自动生成 | 64 位 hex，用于加密 API Key；不设则自动生成 `data/master.key` |
| `BINANCE_BASE_URL` | `https://fapi.binance.com` | 币安 U 本位合约 REST |
| `BINANCE_TIMEOUT_MS` | `8000` | 币安普通请求超时 |
| `BINANCE_RECV_WINDOW` | `5000` | 签名有效期窗口（1000~60000），代理链路慢时调大 |
| `BINANCE_TIME_SYNC_MS` | `60000` | 与币安服务器对时的刷新周期 |
| `TICK_INTERVAL_MS` | `5000` | 机器人 tick 间隔 |
| `BINANCE_FEED` | `live` | 行情源：`live`=币安实时（默认），`mock`=本地模拟 |
| `NODE_ENV` | 无 | 设 `production` 只是标记，不改变行为 |

---

## 1. 前置要求

### 1.1 服务器配置建议

- 起步：**1 核 1G**（本项目常驻内存约 100~200 MB，SQLite 本地读写）
- 推荐：1 核 2G，磁盘 20 GB
- 系统：Ubuntu 22.04 LTS 或 24.04 LTS

### 1.2 安装 Node 24（NodeSource，推荐）

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # 必须 >= v22.5，期望 v24.x
node -e "const {DatabaseSync}=require('node:sqlite');console.log('node:sqlite OK')"
```

> 若 `node:sqlite` 报错，说明 Node 版本过低，必须升级到 22.5+。

### 1.3 备选：nvm 安装（无 root 或需要多版本）

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
# 注意：nvm 装的 node 路径是 ~/.nvm/versions/node/vXX/bin/node，
# 用 systemd 托管时需要把 ExecStart 里的 /usr/bin/node 换成 `which node` 的结果
```

### 1.4 新建非 root 用户 `biance`

```bash
sudo adduser --disabled-password --gecos "" biance
sudo mkdir -p /opt/biance_trae
sudo chown -R biance:biance /opt/biance_trae
```

---

## 2. 上传代码

目标路径统一为 **`/opt/biance_trae`**。

### 2.1 方式 A：git clone（推荐）

```bash
sudo -iu biance
cd /opt/biance_trae
# 换成你自己的仓库地址（本项目公开仓库：https://github.com/MikuYun/BinanceAutoTrad）
# /opt/biance_trae 已存在且非空时，用下面这种「克隆到当前目录」的写法
git clone https://github.com/MikuYun/BinanceAutoTrad.git .
```

### 2.2 方式 B：scp 上传（无 git 仓库时）

在**本机（Windows PowerShell）**执行：

```powershell
# 注意：把 <服务器IP> 和本地项目目录换成实际值
scp -r B:\biance_trae\* biance@<服务器IP>:/opt/biance_trae/
```

上传后要排除本地调试数据 `data/`（不要带到线上）：

```powershell
ssh biance@<服务器IP> "rm -rf /opt/biance_trae/data && mkdir -p /opt/biance_trae/data"
```

---

## 3. 安装与首次启动

```bash
sudo -iu biance
cd /opt/biance_trae

# 本项目零第三方依赖，npm install 只是生成 lockfile，可跳过
npm install --omit=dev || echo "无依赖，跳过亦可"
```

冒烟测试（前台先跑一次，确认能起来）：

```bash
cd /opt/biance_trae
HOST=0.0.0.0 PORT=8787 node server.js
# 看到监听日志后按 Ctrl+C 停止
```

另开一个终端验证：

```bash
curl -I http://127.0.0.1:8787
# 期望返回 HTTP/1.1 200 或 302
```

浏览器访问 `http://<服务器IP>:8787`，能打开登录页即为成功。

> **注意**：首次启动会自动生成 `data/master.key` 和 `data/app.db`。
> 接下来立刻执行第 6 节的文件权限设置。

---

## 4. systemd 托管（重点）

### 4.1 创建 unit 文件

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

> **注意**：`ExecStart` 中的 `/usr/bin/node` 是 NodeSource 安装的路径。
> 用 nvm 安装的必须替换为 `which node` 的输出（绝对路径）。

### 4.2 启动与开机自启

```bash
sudo systemctl daemon-reload
sudo systemctl enable biance-trae
sudo systemctl start biance-trae
sudo systemctl status biance-trae        # 期望 active (running)
```

### 4.3 常用运维命令

```bash
sudo systemctl restart biance-trae       # 重启
sudo systemctl stop biance-trae          # 停止
sudo journalctl -u biance-trae -f        # 实时日志
sudo journalctl -u biance-trae -n 200 --no-pager   # 最近 200 行
sudo journalctl -u biance-trae --since "10 min ago" --no-pager
```

---

## 5. HTTPS + 反向代理（重点）

### 5.1 为什么要 HTTPS

登录使用的是 **Cookie 会话**，币安 **API Key/Secret 也会经接口提交**。
明文 HTTP 下，这些内容走公网会被中间人直接截获，等于把交易权限交出去。
**公网部署必须上 HTTPS**，并且由 Nginx 终结 TLS，Node 只监听本机。

### 5.2 安装 Nginx 与 certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

### 5.3 先把 Node 收回 127.0.0.1

```bash
# 有了 Nginx 反代后，Node 不需要对外暴露
sudo sed -i 's/^Environment=HOST=0.0.0.0$/Environment=HOST=127.0.0.1/' \
  /etc/systemd/system/biance-trae.service
sudo systemctl daemon-reload
sudo systemctl restart biance-trae
```

### 5.4 Nginx 站点配置

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

> **说明**：当前所有接口都是普通 HTTP 请求（含轮询），Nginx 默认行为即可，**不需要** `Upgrade` 头。
> 只有将来引入 WebSocket 推送时，才必须打开上面注释里的两行 `Upgrade`/`Connection`，否则握手会失败。

### 5.5 申请证书（certbot 自动改配置）

```bash
sudo certbot --nginx -d your-domain.example.com
# 按提示填邮箱、同意协议、选择 "Redirect" 强制跳转 HTTPS
sudo certbot renew --dry-run      # 验证自动续期
```

HTTPS 生效后，浏览器访问 `https://your-domain.example.com`。
程序会根据请求是否 HTTPS（直连 TLS，或反代透传的 `X-Forwarded-Proto: https`）自动给登录 Cookie 加上 `Secure` 属性，
**带 Secure 的 Cookie 只能通过 HTTPS 下发**——这也是必须上证书的原因之一。

---

### 5.6 部署到已有站点的子路径（`/biance_trae/`）

如果这台服务器的 80/443 已经被别的站点占用（比如已经有一个站点跑在根路径上），
而你只想把本项目挂到 `http://<域名或IP>/biance_trae/` 下面，**不要去改现有的 server 块**，
而是把下面的 `location` 块**追加到现有站点配置里**（放最前面，靠 `^~` 阻止其他正则匹配抢走）。

**第一步：给 systemd 加上 `BASE_PATH`（重要）**

```bash
sudo sed -i '/^Environment=PORT=/a Environment=BASE_PATH=/biance_trae' \
  /etc/systemd/system/biance-trae.service
sudo systemctl daemon-reload && sudo systemctl restart biance-trae
```

`BASE_PATH` 的作用：后端自动把请求路径上的 `/biance_trae` 前缀剥掉（`/biance_trae/api/me` → `/api/me`），
并把登录 Cookie 的 `Path` 设成 `/biance_trae`。**不同站点的 Cookie 不会互相覆盖，同域其他子路径站点的登录态不受影响。**

**第二步：在 nginx 里追加 location（关键：`proxy_pass` 后面不要带路径）**

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

> ⚠️ **不会影响现有站点的前提**：新增的只有一个 `^~ /biance_trae/` 前缀 location，
> 优先级虽然高于普通 location，但它只匹配 `/biance_trae/` 开头的请求，
> 对同域其他任何路径（包括别的站点和裸 `/api/`）一行都不影响。
> 现有配置**一个字都不用改**，回滚也只需删掉这一段再 reload。
>
> ⚠️ **如果这台机器上已经存在 `location ^~ /api/`（很多站会把裸 `/api/` 反代到后端）**，
> 千万别把本项目的接口挂到裸 `/api/` 上，否则两套服务会抢同一个前缀。
> 本项目所有接口都以 `/biance_trae/api/` 为前缀，天然避开这个问题。

**第三步：验证**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/biance_trae/          # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/biance_trae/app.js    # 期望 200
curl -s http://127.0.0.1/biance_trae/api/market/health                          # 期望 ok:true
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/                       # 期望和部署前一致
```

浏览器打开 `http://<域名或IP>/biance_trae/` 即可。注意末尾的 `/` 不能省。

---

## 6. 安全清单

### 6.1 防火墙只开 22/80/443，8787 不对公网开放

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

> 更稳妥的做法是第 5.3 节那样让 Node 只绑 `127.0.0.1`，此时 8787 物理上无法从外部访问。

### 6.2 收紧数据目录权限

```bash
sudo chown -R biance:biance /opt/biance_trae/data
sudo chmod 700 /opt/biance_trae/data
sudo chmod 600 /opt/biance_trae/data/master.key
sudo chmod 600 /opt/biance_trae/data/app.db
ls -l /opt/biance_trae/data       # 确认 master.key 是 -rw-------
```

### 6.3 必须备份 `data/`（尤其 `master.key`）

**`master.key` 与 `app.db` 必须一起备份、一起恢复。**
只恢复 `app.db` 而丢了 `master.key`，库里所有 API Key 都是无法解密的乱码；
只恢复 `master.key` 而丢了 `app.db`，等于从零开始。

```bash
sudo apt install -y sqlite3
sudo mkdir -p /root/backup && sudo chmod 700 /root/backup
```

**每日备份（crontab，用 SQLite 在线备份命令，避免复制到写一半的库）：**

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

**一次性手动备份+异地拉取：**

```bash
sudo /usr/local/bin/biance-backup.sh
# 从本机（Windows）拉回离线保存，注意 <STAMP> 换成实际时间戳
scp root@<服务器IP>:/root/backup/app.db.* root@<服务器IP>:/root/backup/master.key.* D:\backup\
```

**恢复：**

```bash
sudo systemctl stop biance-trae
sudo cp /root/backup/app.db.<STAMP>     /opt/biance_trae/data/app.db
sudo cp /root/backup/master.key.<STAMP> /opt/biance_trae/data/master.key
sudo chown biance:biance /opt/biance_trae/data/*
sudo chmod 600 /opt/biance_trae/data/master.key /opt/biance_trae/data/app.db
sudo rm -f /opt/biance_trae/data/app.db-wal /opt/biance_trae/data/app.db-shm
sudo systemctl start biance-trae
```

### 6.4 币安 API Key 权限最小化

在币安「API 管理」创建 Key 时：

- 只勾选 **「允许读取」+「允许合约交易」**
- **必须关闭「允许提现」**（关闭后即使 Key 泄露也无法转走资产）
- **绑定服务器出口 IP 白名单**：

```bash
# 在服务器上查出口公网 IP，填到币安 API 的 IP 白名单里
curl -s https://api.ipify.org; echo
```

- 建议限制 Key 可用范围/子账户，实盘先用小资金验证

### 6.5 不要把 `data/` 提交到 git

```bash
cd /opt/biance_trae
grep -qxF 'data/' .gitignore 2>/dev/null || echo 'data/' >> .gitignore
git rm -r --cached data 2>/dev/null || true
git commit -m "chore: ignore data/" || true
```

---

## 7. 升级与回滚

### 7.1 升级

```bash
cd /opt/biance_trae
sudo /usr/local/bin/biance-backup.sh       # 先备份！
sudo -iu biance git pull
sudo systemctl restart biance-trae
sudo journalctl -u biance-trae -n 50 --no-pager     # 确认启动无报错
```

### 7.2 回滚

```bash
cd /opt/biance_trae
git fetch --tags
git tag -l                                  # 查看可用版本
sudo -iu biance git checkout <tag>          # 注意：换成要回滚到的 tag/commit
sudo systemctl restart biance-trae
```

返回最新版：`git checkout main`（或 `master`）。

> **注意**：若新版本改过数据库结构，回滚**前**必须先备份 `data/`；必要时用第 6.3 节的恢复流程还原 `app.db`+`master.key`。

---

## 8. 常见故障排查

### 8.1 端口被占用

```bash
ss -lntp | grep 8787
# 找到 pid 后
sudo kill <PID>
sudo systemctl restart biance-trae
```

### 8.2 启动报 `node:sqlite` 不支持 / 模块找不到

```
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
```

Node 版本低于 22.5。升级：

```bash
node -v
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo systemctl restart biance-trae
```

### 8.3 页面能打开但接口返回 401

- 浏览器开发者工具 → Application → Cookies 看会话 Cookie 是否存在
- HTTPS 访问时 Cookie 会带 `Secure` 属性（后端根据 `X-Forwarded-Proto` 自动判定），**用 http 访问不会带上**
- 反向代理必须透传 `Host`、`X-Forwarded-Proto`（见 5.4），否则后端以为你在走 http，Cookie 不带 `Secure`，同时某些功能也会误判
- 检查服务器时间是否准确：`timedatectl status`（时间漂移会导致会话/签名校验失败）
- 清理浏览器该站点 Cookie 后重新登录

### 8.4 实盘账户读不到余额

逐项排查：

```bash
# 1) 服务器能否访问币安合约域名
curl -s -o /dev/null -w "%{http_code}\n" https://fapi.binance.com/fapi/v1/time
# 期望 200；超时/000 说明网络不通或需代理

# 2) 出口 IP 是否与币安白名单一致
curl -s https://api.ipify.org; echo
```

- Key 未开「合约交易」权限 → 币安返回 `-2015` / `-2014`
- Key 绑定了 IP 白名单但与服务器出口 IP 不一致 → `-2015` Invalid API-key, IP, or permissions
- 时区/时间不准 → `recvWindow` 超限（本项目 `recvWindow=5000`）
- 使用的是国内被屏蔽域名环境 → 配置可用出口或自建代理后改 `BINANCE_BASE_URL`

### 8.5 `data/master.key` 丢失/损坏

**表现**：机器人启动正常，但列出 API Key 时报解密失败；旧 Key 全部不可用。

```bash
ls -l /opt/biance_trae/data/master.key
sudo journalctl -u biance-trae -n 100 --no-pager | grep -i -E 'decrypt|master|key'
```

**处理**：

1. 若只是权限/文件被删且**没有备份**：已加密的 API Key **无法恢复**，只能删除旧 Key 重新录入（`master.key` 会重新生成）。
2. 若有第 6.3 节的备份：按恢复流程把 `master.key` 与 `app.db` **一起**还原。
3. 想避免该文件丢失：改用环境变量 `BT_MASTER_KEY=<64位hex>` 固化到 systemd unit（但环境变量会出现在 `systemctl show` 中，注意主机权限）。

---

## 9. 可选：Docker 部署

**Dockerfile（只给内容，不创建文件）：**

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

构建与运行：

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

> **注意**：`-v /opt/biance_trae/data:/app/data` **必须挂载**。
> 不挂载 volume 时，容器重建/升级后 `data/`（含 `master.key` 和 `app.db`）全部丢失，API Key 无法解密。
> `-p` 只绑 `127.0.0.1`，继续由宿主机 Nginx 反代。容器方案下第 6.2 节的权限设置仍要在宿主机数据目录上执行。

---

## 10. 部署后自检清单

- [ ] `sudo systemctl status biance-trae` 显示 `active (running)`，且 `journalctl` 无报错
- [ ] 浏览器能用 `https://<域名>` 打开登录页，证书有效（非自签名告警）
- [ ] 能成功注册/登录，刷新页面后会话仍在
- [ ] 行情区能看到实时价格（`BINANCE_FEED=mock` 时有模拟价格在跳动）
- [ ] 能创建一个**模拟盘**机器人，且状态正常流转
- [ ] 能设置模拟盘余额，数值正确显示
- [ ] `sudo systemctl restart biance-trae` 后重新登录，用户/机器人/订单数据仍在
- [ ] `ss -lntp | grep 8787` 显示只监听 `127.0.0.1:8787`，公网 `http://<IP>:8787` 打不开
- [ ] `sudo ufw status` 中 8787 为 deny，仅 22/80/443 为 allow
- [ ] `ls -l /opt/biance_trae/data` 权限为 `700`，`master.key` 为 `600`
- [ ] 手动执行一次备份脚本，`/root/backup/` 下同时出现 `app.db.*` 与 `master.key.*`
