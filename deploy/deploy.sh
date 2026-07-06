#!/usr/bin/env bash
#
# ChatTodo 论坛 —— 一键部署脚本（OpenCloudOS / RHEL 系 · 原生 Postgres · IP 直连 · 纯 HTTP）
# ===========================================================================================
# 目标场景（与部署问答一致）：
#   - 系统：OpenCloudOS / RHEL / CentOS / Rocky（dnf + firewalld + SELinux）
#   - 数据库：原生 dnf 安装的 PostgreSQL，仅监听 127.0.0.1
#   - 对外：没有域名，用公网 IP 直接访问；Caddy 在 :80 反代到 NodeBB(127.0.0.1:4567)，纯 HTTP
#   - 代码：公开仓库，HTTPS 免鉴权 clone
#
# 用法（在 VPS 上以 root 运行）：
#   curl -fsSL <本文件的 raw 地址> -o deploy.sh   # 或 scp 上来
#   sudo bash deploy.sh
#
# 可用环境变量覆盖默认值（都可选）：
#   PUBLIC_ADDR=1.2.3.4      对外访问用的 IP（不填则自动探测公网 IP）
#   REPO_URL=https://...     仓库 clone 地址（默认见下）
#   BRANCH=main              要部署的分支/标签
#   APP_DIR=/opt/chattodo-forum
#   RUN_USER=nodebb
#   NODE_VERSION=22.23.1
#   HTTP_PORT=80             Caddy 对外端口
#
# 本脚本幂等：可反复运行。二次运行 = 拉取最新代码 + 重新构建 + 重启（相当于更新部署）。
# 首次运行会生成随机的数据库密码与管理员密码，写入 /opt/chattodo-forum/.env，并在结尾打印。
#
set -Eeuo pipefail

# ── 可覆盖配置 ────────────────────────────────────────────────────────────────
REPO_URL="${REPO_URL:-https://github.com/chienhsiung-wu/chattodo-forum.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/chattodo-forum}"
RUN_USER="${RUN_USER:-nodebb}"
NODE_VERSION="${NODE_VERSION:-22.23.1}"
NBB_PORT="${NBB_PORT:-4567}"
HTTP_PORT="${HTTP_PORT:-80}"
PGDATA_DIR="${PGDATA_DIR:-/var/lib/pgsql/data}"

DBNAME="${DBNAME:-nodebb}"
DBUSER="${DBUSER:-nodebb}"

# ── 小工具 ──────────────────────────────────────────────────────────────────
c_step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
c_info() { printf '    %s\n' "$*"; }
c_warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()    { printf '\033[1;31m[fatal]\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "在第 ${LINENO} 行出错（命令：${BASH_COMMAND}）。请查看上方输出定位。"' ERR

# ── 0. 前置检查 ─────────────────────────────────────────────────────────────
c_step "0/10 前置检查"
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash deploy.sh"
command -v dnf >/dev/null 2>&1 || die "未找到 dnf。本脚本仅适用于 RHEL 系（OpenCloudOS/CentOS/Rocky）。Debian/Ubuntu 请改用 apt 版流程。"
c_info "系统：$(. /etc/os-release && echo "$PRETTY_NAME")"

# 公网 IP：优先用传入的 PUBLIC_ADDR，否则依次尝试探测
if [ -z "${PUBLIC_ADDR:-}" ]; then
	PUBLIC_ADDR="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
	[ -z "$PUBLIC_ADDR" ] && PUBLIC_ADDR="$(curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
	[ -z "$PUBLIC_ADDR" ] && PUBLIC_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
[ -n "$PUBLIC_ADDR" ] || die "无法自动探测公网 IP，请显式指定：PUBLIC_ADDR=你的IP sudo -E bash deploy.sh"
NBB_URL="http://${PUBLIC_ADDR}"
[ "$HTTP_PORT" = "80" ] || NBB_URL="http://${PUBLIC_ADDR}:${HTTP_PORT}"
c_info "对外地址：${NBB_URL}（纯 HTTP，无域名/无 TLS）"

# ── 1. 基础工具 ─────────────────────────────────────────────────────────────
c_step "1/10 安装基础工具"
dnf install -y git curl tar xz openssl policycoreutils >/dev/null
c_info "git / curl / tar / xz / openssl 就绪"

# ── 2. Node（官方静态二进制，需 >= 22.10）────────────────────────────────────
c_step "2/10 安装 Node ${NODE_VERSION}"
need_node=1
if command -v node >/dev/null 2>&1; then
	cur="$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)"
	major="${cur%%.*}"; rest="${cur#*.}"; minor="${rest%%.*}"
	if [ "${major:-0}" -gt 22 ] || { [ "${major:-0}" -eq 22 ] && [ "${minor:-0}" -ge 10 ]; }; then
		need_node=0
		c_info "已安装 node v${cur}（满足 >= 22.10），跳过"
	else
		c_warn "现有 node v${cur} < 22.10（NodeBB v4 会踩 undici 的 markAsUncloneable 坑），将安装静态包"
	fi
fi
if [ "$need_node" -eq 1 ]; then
	arch="$(uname -m)"; case "$arch" in x86_64) narch=x64;; aarch64|arm64) narch=arm64;; *) die "未知架构 $arch";; esac
	tarball="node-v${NODE_VERSION}-linux-${narch}.tar.xz"
	curl -fLo "/tmp/${tarball}" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
	tar -xJf "/tmp/${tarball}" -C /usr/local --strip-components=1
	rm -f "/tmp/${tarball}"
	c_info "node $(/usr/local/bin/node --version) / npm $(/usr/local/bin/npm --version)"
fi
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
c_info "node 路径：${NODE_BIN}"

# ── 3. 运行用户 ─────────────────────────────────────────────────────────────
c_step "3/10 创建运行用户 ${RUN_USER}"
if id "$RUN_USER" >/dev/null 2>&1; then
	c_info "用户已存在，跳过"
else
	useradd --system --create-home --shell /bin/bash "$RUN_USER"
	c_info "已创建系统用户 ${RUN_USER}"
fi

# ── 4. 原生 PostgreSQL ──────────────────────────────────────────────────────
c_step "4/10 安装并初始化 PostgreSQL（原生，仅监听 127.0.0.1）"
dnf install -y postgresql-server postgresql >/dev/null
if [ ! -f "${PGDATA_DIR}/PG_VERSION" ]; then
	c_info "首次初始化数据目录 ${PGDATA_DIR}"
	postgresql-setup --initdb
else
	c_info "数据目录已初始化，跳过 initdb"
fi
systemctl enable --now postgresql >/dev/null
# 允许本机 TCP 密码登录（md5）；确保 pg_hba 有对应行
HBA="${PGDATA_DIR}/pg_hba.conf"
if ! grep -Eq "^host\s+${DBNAME}\s+${DBUSER}\s+127\.0\.0\.1/32\s+md5" "$HBA"; then
	printf 'host    %s    %s    127.0.0.1/32    md5\n' "$DBNAME" "$DBUSER" >> "$HBA"
	c_info "已向 pg_hba.conf 追加本机 md5 认证行"
	systemctl restart postgresql
fi

# ── 5. .env（首次生成随机密码；已存在则复用，保证前后一致）────────────────────
c_step "5/10 生成 .env"
mkdir -p "$APP_DIR"
ENV_FILE="${APP_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
	c_info ".env 已存在，复用其中的密码（如需重置请先删除 ${ENV_FILE}）"
	# shellcheck disable=SC1090
	set -a; . "$ENV_FILE"; set +a
	DBPASS="${DBPASS:?现有 .env 缺少 DBPASS}"
	ADMIN_PASSWORD="${ADMIN_PASSWORD:?现有 .env 缺少 ADMIN_PASSWORD}"
else
	DBPASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
	ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-18)"
	cat > "$ENV_FILE" <<EOF
# 由 deploy.sh 生成于首次部署。含密码，切勿提交 git（.gitignore 已忽略）。
NBB_URL=${NBB_URL}
NBB_PORT=${NBB_PORT}

PGHOST=127.0.0.1
PGPORT=5432
DBNAME=${DBNAME}
DBUSER=${DBUSER}
DBPASS=${DBPASS}
PG_HOST_PORT=5432

ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF
	c_info "已生成 ${ENV_FILE}（数据库/管理员密码为随机强口令）"
fi
# NBB_URL 每次都对齐当前探测到的地址（IP 变了也能纠正）
if grep -q '^NBB_URL=' "$ENV_FILE"; then
	sed -i "s#^NBB_URL=.*#NBB_URL=${NBB_URL}#" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"   # 含密码，收紧权限

# ── 6. 拉取代码 ─────────────────────────────────────────────────────────────
c_step "6/10 拉取代码（${REPO_URL} @ ${BRANCH}）"
if [ -d "${APP_DIR}/.git" ]; then
	c_info "已存在仓库，git fetch + reset 到 origin/${BRANCH}"
	git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
	git -C "$APP_DIR" checkout -B "$BRANCH" "origin/${BRANCH}"
else
	# APP_DIR 已因 .env 而存在且非空，clone 到临时目录再搬运，避免“目录非空”报错
	tmp="$(mktemp -d)"
	git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$tmp"
	shopt -s dotglob
	# 保留已生成的 .env，其余文件搬入
	mv "$tmp"/* "$APP_DIR"/ 2>/dev/null || true
	shopt -u dotglob
	rm -rf "$tmp"
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
c_info "代码就绪于 ${APP_DIR}"

# ── 7. 建库账号 + 一键 setup（建库/装插件/灌种子，幂等）──────────────────────
c_step "7/10 数据库账号 & 应用安装（npm run setup）"
# 确保 DB 角色/库存在，且密码与 .env 对齐（幂等）
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DBUSER}') THEN
    CREATE ROLE ${DBUSER} LOGIN;
  END IF;
END \$\$;
ALTER ROLE ${DBUSER} WITH PASSWORD '${DBPASS}';
SELECT 'CREATE DATABASE ${DBNAME} OWNER ${DBUSER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DBNAME}')\gexec
SQL
c_info "PostgreSQL 角色 ${DBUSER} / 库 ${DBNAME} 就绪"

# 以运行用户执行 setup：读 .env 拿到连接信息与域名；PATH 保证能找到静态包 node/npm
sudo -u "$RUN_USER" env PATH="/usr/local/bin:/usr/bin:/bin" bash -c '
	set -Eeuo pipefail
	cd "'"$APP_DIR"'"
	set -a; . ./.env; set +a
	npm install --no-audit --no-fund
	npm run setup
'
c_info "应用安装完成（NodeBB 克隆/补丁/建表/插件/构建/种子）"

# ── 8. systemd 托管 NodeBB ──────────────────────────────────────────────────
c_step "8/10 安装 systemd 服务（NodeBB）"
sed -e "s#^User=.*#User=${RUN_USER}#" \
    -e "s#^Group=.*#Group=${RUN_USER}#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=${APP_DIR}/nodebb#" \
    -e "s#^ExecStart=.*#ExecStart=${NODE_BIN} ${APP_DIR}/nodebb/loader.js --no-daemon --no-silent#" \
    -e "s#^EnvironmentFile=.*#EnvironmentFile=${APP_DIR}/.env#" \
    "${APP_DIR}/deploy/chattodo-forum.service" > /etc/systemd/system/chattodo-forum.service
systemctl daemon-reload
systemctl enable --now chattodo-forum
c_info "chattodo-forum.service 已启动"

# ── 9. Caddy 反代（纯 HTTP，:${HTTP_PORT} → 127.0.0.1:${NBB_PORT}）───────────
c_step "9/10 安装 Caddy 反代（纯 HTTP）"
if ! command -v caddy >/dev/null 2>&1; then
	arch="$(uname -m)"; case "$arch" in x86_64) carch=amd64;; aarch64|arm64) carch=arm64;; *) die "未知架构 $arch";; esac
	curl -fL "https://caddyserver.com/api/download?os=linux&arch=${carch}" -o /tmp/caddy
	install -m 0755 /tmp/caddy /usr/bin/caddy && rm -f /tmp/caddy
fi
c_info "caddy $(caddy version | head -1)"
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy /var/log/caddy && chown -R caddy:caddy /var/log/caddy
# 纯 HTTP 站点：用 :端口 作为站点地址即禁用自动 HTTPS（无域名场景的正确姿势）
cat > /etc/caddy/Caddyfile <<EOF
# 由 deploy.sh 生成 —— IP 直连 / 纯 HTTP。日后有域名再换成 "your.domain { ... }" 即自动签发 TLS。
:${HTTP_PORT} {
	reverse_proxy 127.0.0.1:${NBB_PORT}
	encode zstd gzip
	log {
		output file /var/log/caddy/forum-access.log
		format console
	}
}
EOF
cp "${APP_DIR}/deploy/caddy.service" /etc/systemd/system/caddy.service
systemctl daemon-reload
systemctl enable --now caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy
c_info "caddy.service 已启动，监听 :${HTTP_PORT}"

# ── 10. 防火墙 + SELinux + 验收 ─────────────────────────────────────────────
c_step "10/10 防火墙 / SELinux / 验收"
# firewalld：放行对外 HTTP 端口；4567 与 Postgres 不对外
if systemctl is-active --quiet firewalld; then
	if [ "$HTTP_PORT" = "80" ]; then
		firewall-cmd --permanent --add-service=http >/dev/null
	else
		firewall-cmd --permanent --add-port="${HTTP_PORT}/tcp" >/dev/null
	fi
	firewall-cmd --reload >/dev/null
	c_info "firewalld 已放行 ${HTTP_PORT}/tcp"
else
	c_warn "firewalld 未运行，跳过本地防火墙配置（请确认云厂商安全组已放行 ${HTTP_PORT}）"
fi
# SELinux：允许反代进程连本机后端（否则 Caddy 起得来但 502）
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
	setsebool -P httpd_can_network_connect 1
	c_info "SELinux enforcing：已放行 httpd_can_network_connect"
fi

# 等待 NodeBB 端口就绪后验收
c_info "等待 NodeBB 就绪..."
ok=0
for _ in $(seq 1 30); do
	if curl -fsS -o /dev/null "http://127.0.0.1:${NBB_PORT}/"; then ok=1; break; fi
	sleep 2
done
[ "$ok" -eq 1 ] || c_warn "本地 127.0.0.1:${NBB_PORT} 30 秒内未就绪，查日志：journalctl -u chattodo-forum -e"
front="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT}/" 2>/dev/null || echo '000')"

# ── 收尾输出 ────────────────────────────────────────────────────────────────
printf '\n\033[1;32m============================ 部署完成 ============================\033[0m\n'
cat <<EOF
  访问地址 :  ${NBB_URL}
  本地反代 :  http://127.0.0.1:${HTTP_PORT}/  →  ${front}
  管理后台 :  ${NBB_URL}/admin
  管理员   :  siteadmin
  管理密码 :  ${ADMIN_PASSWORD}
  （以上密码同样保存在 ${ENV_FILE}）

  常用运维：
    systemctl status chattodo-forum
    journalctl -u chattodo-forum -f
    systemctl restart chattodo-forum
    # 更新部署：再次运行本脚本即可（会拉最新代码 + 重建 + 重启）

  安全提醒（纯 HTTP · IP 直连）：
    - 管理员登录密码是明文传输的，请仅在可信网络下登录 /admin。
    - 云厂商安全组务必只放行 ${HTTP_PORT}（和 SSH）；切勿对外暴露 4567 / 5432。
    - 日后有域名后：改 /etc/caddy/Caddyfile 为 "域名 { reverse_proxy 127.0.0.1:${NBB_PORT} }"，
      并把 .env 的 NBB_URL 改为 https://域名，重跑 setup 或改 nodebb/config.json 的 url，即得自动 HTTPS。
EOF
printf '\033[1;32m=================================================================\033[0m\n'
