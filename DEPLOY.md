# 部署到 OpenCloudOS 服务器（Caddy 反代 · 纯浏览上线）

本清单对应「先不接真实 App SSO、以公开浏览为主」的上线目标。目标系统 **OpenCloudOS**
（腾讯云，RHEL/CentOS 血统，用 `dnf`、`firewalld`、SELinux）。后续接真实登录/IM 见文末。

> 约定：项目部署在 `/opt/chattodo-forum`，运行用户 `nodebb`，域名 `forum.example.com`。
> 按你的实际情况替换这些值（同时改 `deploy/*.service`、`deploy/Caddyfile`、`.env`）。
>
> 命令用 `dnf`（RHEL 系）。若你实际是 Debian/Ubuntu，把 `dnf install` 换成 `apt-get install`、
> Node/Caddy 改用各自的 apt 源即可，其余步骤一致。

---

## 0. 前置

- OpenCloudOS（8/9 系），有 sudo。查版本：`cat /etc/os-release`。
- 域名 `forum.example.com` 的 A/AAAA 记录已指向服务器公网 IP。
- **腾讯云安全组**对外只放行 **80、443**（SSH 另计）——这是第一道，务必在控制台配置。
  服务器本地 `firewalld` 见第 8.5 步。**不要**对外暴露 4567 / Postgres。
- 装基础工具：`sudo dnf install -y git curl tar`。

## 1. 安装 Node ≥ 22.10 LTS（官方静态二进制，与发行版无关）

NodeSource 的 rpm 源不一定识别 OpenCloudOS，直接用官方静态包最稳（和本机 portable Node 一个思路）。
本机沙箱因系统 Node 22.9.0 缺 `markAsUncloneable` 才用 portable；服务器装新版即无此坑。

```bash
cd /tmp
curl -fLO https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz
sudo tar -xJf node-v22.23.1-linux-x64.tar.xz -C /usr/local --strip-components=1
node --version   # v22.23.1；which node → /usr/local/bin/node
npm --version
```

> 若偏好包管理器：OpenCloudOS 8 可 `sudo dnf module install nodejs:22`（前提模块流有 22），
> 但要确认版本 ≥ 22.10，否则仍会踩 undici 的 `markAsUncloneable` 坑。拿不准就用上面的静态包。

## 2. 建运行用户 + 拉代码

```bash
sudo useradd --system --create-home --shell /bin/bash nodebb
sudo mkdir -p /opt/chattodo-forum && sudo chown nodebb:nodebb /opt/chattodo-forum
sudo -u nodebb git clone <你的仓库地址> /opt/chattodo-forum
cd /opt/chattodo-forum
sudo -u nodebb git checkout <部署分支>
```

## 3. 准备 Postgres

任选其一。**OpenCloudOS 上推荐 B（原生 dnf）**，比装 Docker 更省事；已经在用 Docker 才选 A。

**A) Docker Compose（本仓库自带 `docker-compose.yml`）**
```bash
# OpenCloudOS 装 docker：sudo dnf install -y docker docker-compose-plugin && sudo systemctl enable --now docker
cd /opt/chattodo-forum
sudo -u nodebb PG_HOST_PORT=5432 docker compose up -d postgres
```

**B) 原生 dnf 安装（RHEL 系需手动 initdb）**
```bash
sudo dnf install -y postgresql-server
sudo postgresql-setup --initdb                 # RHEL 系首次必须初始化数据目录
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "CREATE USER nodebb WITH PASSWORD '强密码';"
sudo -u postgres psql -c "CREATE DATABASE nodebb OWNER nodebb;"
# RHEL 系默认 peer/ident 认证，需允许本机 TCP 密码登录：
#   编辑 /var/lib/pgsql/data/pg_hba.conf，确保有一行：
#     host  nodebb  nodebb  127.0.0.1/32  md5
#   然后 sudo systemctl restart postgresql
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

## 8. 装 Caddy 反代 + 自动 TLS（官方静态二进制）

Caddy 官方 apt 源不适用于 OpenCloudOS，用官方静态二进制 + 本仓库自带的 `deploy/caddy.service`。

```bash
# 1) 下载静态二进制（amd64；ARM 机器把 amd64 换成 arm64）
curl -fL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /tmp/caddy
sudo install -m 0755 /tmp/caddy /usr/bin/caddy
caddy version

# 2) 建 caddy 用户与目录
sudo useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy 2>/dev/null || true
sudo mkdir -p /etc/caddy /var/log/caddy && sudo chown -R caddy:caddy /var/log/caddy

# 3) 放站点配置（把域名改成你的）
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo vi /etc/caddy/Caddyfile                  # 改 forum.example.com

# 4) 装 systemd 单元并启动
sudo cp deploy/caddy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now caddy
journalctl -u caddy -f                        # 看证书签发是否成功
```

## 8.5 防火墙（firewalld）

```bash
sudo firewall-cmd --permanent --add-service=http     # 80
sudo firewall-cmd --permanent --add-service=https    # 443
sudo firewall-cmd --reload
sudo firewall-cmd --list-services                    # 确认含 http https
```
> 注意：腾讯云**安全组**是更外层的一道，也必须放行 80/443，否则 firewalld 放了也进不来。
> 4567 与 Postgres **不要**加入任何放行规则。

## 8.6 SELinux（RHEL 系特有，反代 502 时看这里）

OpenCloudOS 默认 SELinux 常为 enforcing。它会**默认禁止 Caddy 主动向 127.0.0.1:4567 发起连接**，
表现为 Caddy 能起、但访问返回 502。放行本机 HTTP 出站连接：
```bash
getenforce                                    # Enforcing / Permissive / Disabled
sudo setsebool -P httpd_can_network_connect 1 # 允许反代进程连本机后端（持久）
```
若仍 502，用 `sudo ausearch -m avc -ts recent` 看被拒的具体项，再按提示放行。
（Permissive/Disabled 的机器无需此步。）

## 9. 验收

```bash
curl -sI https://forum.example.com/ | head -1          # HTTP/2 200
```
浏览器打开 `https://forum.example.com`：
- 首页、6 个版块、22 篇种子帖可正常浏览（只读）。
- 用第 5 步的 `siteadmin` / 管理员密码可登录后台 `/admin`（走 NodeBB 本地账号，不经 SSO）。
- 「使用 灵信账号登录」按钮本次不可用（真 SSO 未接），属预期。

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

