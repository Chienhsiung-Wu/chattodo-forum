#!/usr/bin/env bash
#
# 一键重建论坛环境（幂等）。nodebb/ 目录不入库，本脚本从零克隆并配置。
# 前置：Node ≥ 20、可用的 PostgreSQL、可访问 npm registry 与 github。
#
# 用法：bash scripts/install.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NBB="$ROOT/nodebb"
NBB_VERSION="v4.11.3"

PGHOST="${PGHOST:-127.0.0.1}"; PGPORT="${PGPORT:-5432}"
DBNAME="${DBNAME:-nodebb}"; DBUSER="${DBUSER:-nodebb}"; DBPASS="${DBPASS:-nodebb}"
NBB_URL="${NBB_URL:-http://localhost:4567}"

echo "==> 1/9 检查 Node 版本 (需 ≥ 20)"
node -e "process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)" || { echo "Node < 20，请升级"; exit 1; }

echo "==> 2/9 确保 PostgreSQL 可用（角色/库 $DBUSER/$DBNAME）"
# 本仓库开发环境用系统自带 Postgres；真实部署可改用 docker compose up -d（见 docker-compose.yml）。
if command -v pg_ctlcluster >/dev/null 2>&1; then
  pg_ctlcluster 16 main start >/dev/null 2>&1 || true
fi
if command -v psql >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
  su postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='$DBUSER'\"" 2>/dev/null | grep -q 1 \
    || su postgres -c "psql -c \"CREATE ROLE $DBUSER LOGIN PASSWORD '$DBPASS';\"" >/dev/null 2>&1 || true
  su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='$DBNAME'\"" 2>/dev/null | grep -q 1 \
    || su postgres -c "createdb -O $DBUSER $DBNAME" >/dev/null 2>&1 || true
fi

echo "==> 3/9 克隆 NodeBB $NBB_VERSION"
[ -d "$NBB/.git" ] || git clone --depth 1 --branch "$NBB_VERSION" https://github.com/NodeBB/NodeBB.git "$NBB"

echo "==> 4/9 安装 NodeBB 依赖"
( cd "$NBB" && npm install --no-audit --no-fund )

echo "==> 5/9 施加核心补丁（EMFILE 分批并发）"
node "$ROOT/scripts/patch-nodebb.js"

echo "==> 6/9 生成 config.json 并初始化（若不存在）"
if [ ! -f "$NBB/config.json" ]; then
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  ADMINPW="${ADMIN_PASSWORD:-$(node -e "console.log('Ct!'+require('crypto').randomBytes(9).toString('base64url'))")}"
  cat > "$ROOT/scripts/setup.json" <<JSON
{
  "url": "$NBB_URL",
  "secret": "$SECRET",
  "database": "postgres",
  "port": "4567",
  "postgres:host": "$PGHOST",
  "postgres:port": "$PGPORT",
  "postgres:username": "$DBUSER",
  "postgres:password": "$DBPASS",
  "postgres:database": "$DBNAME",
  "postgres:ssl": false,
  "admin:username": "siteadmin",
  "admin:email": "admin@bbs.chattodo.local",
  "admin:password": "$ADMINPW",
  "admin:password:confirm": "$ADMINPW"
}
JSON
  ( cd "$NBB" && ./nodebb setup "$(cat "$ROOT/scripts/setup.json")" ) || true
  # threads=1 → maxThreads=0，禁用 minifier 子进程 fork（沙箱内 IPC 不稳）
  node -e "const fs=require('fs'),p='$NBB/config.json',c=require(p);c.threads=1;fs.writeFileSync(p,JSON.stringify(c,null,4))"
  echo "    ★ 管理员账号 siteadmin / 密码：$ADMINPW"
fi

echo "==> 7/9 自研插件：依赖 + 符号链接 + 激活"
( cd "$NBB" && npm install passport-oauth2@1.8.0 --no-audit --no-fund )
ln -sfn "$ROOT/plugins/nodebb-plugin-chattodo-sso"   "$NBB/node_modules/nodebb-plugin-chattodo-sso"
ln -sfn "$ROOT/plugins/nodebb-plugin-chattodo-forum" "$NBB/node_modules/nodebb-plugin-chattodo-forum"
( cd "$NBB" && ./nodebb activate nodebb-plugin-chattodo-sso  && ./nodebb activate nodebb-plugin-chattodo-forum )

echo "==> 8/9 构建前端资源"
( cd "$NBB" && ./nodebb build )

echo "==> 9/9 安装编排依赖 + 初始化结构与种子内容"
( cd "$ROOT" && npm install --no-audit --no-fund )
# 需要 NodeBB 与 mock SSO 均未启动也可运行（bootstrap 直连数据库）
NODE_PATH="$NBB/node_modules" node "$ROOT/scripts/bootstrap.js"

echo ""
echo "✅ 安装完成。启动全部服务： bash scripts/dev-up.sh"
echo "   验收截图：            node scripts/screenshots.mjs"
