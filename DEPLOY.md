# 部署到 Ubuntu 服务器（Caddy 反代 · 纯浏览上线）

本清单对应「先不接真实 App SSO、以公开浏览为主」的上线目标。全程在 Ubuntu 上操作。
后续要开放真实登录/团队 IM 通知时，见文末「后续：接真实 SSO / IM」。

> 约定：项目部署在 `/opt/chattodo-forum`，运行用户 `nodebb`，域名 `forum.example.com`。
> 按你的实际情况替换这些值（同时改 `deploy/*.service`、`deploy/Caddyfile`、`.env`）。

---

## 0. 前置

- Ubuntu 22.04/24.04，有 sudo。
- 域名 `forum.example.com` 的 A/AAAA 记录已指向服务器公网 IP。
- 云安全组/防火墙对外只放行 **80、443**（SSH 另计）。**不要**对外暴露 4567 / Postgres。

## 1. 安装 Node ≥ 22.10 LTS

本机沙箱因系统 Node 22.9.0 缺 `markAsUncloneable` 才用了 portable Node；服务器直接装新版即可，无此坑。

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version   # 需 >= v22.10
```

## 2. 建运行用户 + 拉代码

```bash
sudo useradd --system --create-home --shell /bin/bash nodebb
sudo mkdir -p /opt/chattodo-forum && sudo chown nodebb:nodebb /opt/chattodo-forum
sudo -u nodebb git clone <你的仓库地址> /opt/chattodo-forum
cd /opt/chattodo-forum
sudo -u nodebb git checkout <部署分支>
```

## 3. 准备 Postgres

任选其一，二选一即可：

**A) Docker Compose（本仓库自带 `docker-compose.yml`）**
```bash
# 安装 docker + compose 插件后：
cd /opt/chattodo-forum
sudo -u nodebb PG_HOST_PORT=5432 docker compose up -d postgres
```

**B) 原生 apt 安装**
```bash
sudo apt-get install -y postgresql
sudo -u postgres psql -c "CREATE USER nodebb WITH PASSWORD '强密码';"
sudo -u postgres psql -c "CREATE DATABASE nodebb OWNER nodebb;"
```

无论哪种，Postgres 都**只监听 127.0.0.1**，不要对公网开放。

## 4. 配置 .env

```bash
cd /opt/chattodo-forum
sudo -u nodebb cp .env.example .env
sudo -u nodebb nano .env
```
至少填对：`NBB_URL=https://forum.example.com`、`DBPASS`（与第 3 步一致）、`ADMIN_PASSWORD`。
SSO_* / IM_WEBHOOK 本次留空。

## 5. 一键安装（建库 + 装插件 + 灌种子）

```bash
cd /opt/chattodo-forum
# 让 setup 读到 .env 里的连接信息与域名
sudo -u nodebb bash -c 'set -a; . ./.env; set +a; NBB_URL="$NBB_URL" PGPORT="$PGPORT" PG_HOST_PORT="$PG_HOST_PORT" npm install && npm run setup'
```
setup 完成会打印管理员账号（`siteadmin`）与密码。记下它。

> 生产可选优化：安装后编辑 `nodebb/config.json`，把沙箱遗留的 `"threads": 1` 删掉，
> 让前端资源多线程压缩（构建更快）。删后执行 `sudo -u nodebb npx nodebb build`。

## 6. 确认 config.url 指向域名

setup 会用 `NBB_URL` 写入 `nodebb/config.json` 的 `url`。核对一下：
```bash
sudo -u nodebb node -e "console.log(require('/opt/chattodo-forum/nodebb/config.json').url)"
# 应输出 https://forum.example.com
```
若还是 localhost，手动改 `nodebb/config.json` 的 `url` 字段为你的域名。这个值决定
Cookie 作用域 / CSRF / socket.io 连接地址，**必须是公网域名**，否则远程浏览器会连不上。

## 7. 用 systemd 托管 NodeBB

```bash
sudo cp deploy/chattodo-forum.service /etc/systemd/system/
# 按实际改 unit 里的 User / WorkingDirectory / ExecStart 中 node 与项目的绝对路径
#   node 绝对路径查：which node
sudo systemctl daemon-reload
sudo systemctl enable --now chattodo-forum
sudo systemctl status chattodo-forum        # 看是否 running
journalctl -u chattodo-forum -f             # 跟踪日志，等 "NodeBB is now listening"
```

验证本地端口：
```bash
curl -sI http://127.0.0.1:4567/ | head -1   # 期望 HTTP/1.1 200 OK
```

## 8. 装 Caddy 反代 + 自动 TLS

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# 放置站点配置（把域名改成你的）
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile               # 改 forum.example.com
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
journalctl -u caddy -f                        # 看证书签发是否成功
```

## 9. 验收

```bash
curl -sI https://forum.example.com/ | head -1          # HTTP/2 200
```
浏览器打开 `https://forum.example.com`：
- 首页、6 个版块、22 篇种子帖可正常浏览（只读）。
- 用第 5 步的 `siteadmin` / 管理员密码可登录后台 `/admin`（走 NodeBB 本地账号，不经 SSO）。
- 「使用 ChatTodo 账号登录」按钮本次不可用（真 SSO 未接），属预期。

## 10. 日常运维

```bash
# 重启 / 停止 / 日志
sudo systemctl restart chattodo-forum
sudo systemctl stop chattodo-forum
journalctl -u chattodo-forum -f

# 更新代码后
cd /opt/chattodo-forum && sudo -u nodebb git pull
sudo -u nodebb npx --prefix nodebb nodebb build   # 如有前端/插件变更
sudo systemctl restart chattodo-forum

# 数据库备份（建议加 cron 每日跑，并验证可恢复）
sudo -u nodebb pg_dump -h 127.0.0.1 -U nodebb nodebb | gzip > /opt/chattodo-forum/backup/nodebb-$(date +%F).sql.gz
```

---

## 安全小结（务必确认）

- 对外只开 80/443；4567、Postgres、任何 mock/webhook 仅本机监听。
- `config.json` 的 `secret` 与 admin 密码为强随机值；`config.json` / `.env` 不入 git。
- Postgres 用强密码。
- 定期备份并**实测恢复**。

## 后续：接真实 SSO / IM（本次不做，留档）

当要开放真实 App 登录、团队通知时：

1. **SSO**：在 `.env` 填 `SSO_BASE`（真实 App 的 OAuth2 后端）、`SSO_CLIENT_ID`、`SSO_CLIENT_SECRET`。
   该后端须实现 `mocks/sso/server.js` 同款契约：`/authorize`→`/token`→`/userinfo`，且
   `/userinfo` 返回 `id/username/displayname/email/phone_only/add_groups/remove_groups/member_*`。
   在 App 后端把回调地址 `https://forum.example.com/auth/chattodo/callback` 加入白名单。重启服务。
2. **IM**：在 `.env` 填 `IM_WEBHOOK` 为真实飞书/钉钉/企微/Slack 机器人地址，按对方消息格式改
   `mocks/im/server.js` 的 adapt（或让插件直接推到对方 webhook）。
3. **SMTP**：后台 `/admin/settings/email` 配置真实 SMTP，用于邮件通知/找回。

