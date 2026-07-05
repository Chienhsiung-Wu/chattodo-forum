#!/usr/bin/env bash
#
# 启动全部服务：PostgreSQL（本地）+ mock SSO + mock IM + NodeBB。
# 用法：bash scripts/dev-up.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NBB="$ROOT/nodebb"
LOGDIR="${LOGDIR:-/tmp/chattodo-forum}"
mkdir -p "$LOGDIR"

echo "==> PostgreSQL"
if command -v pg_ctlcluster >/dev/null 2>&1; then
  pg_ctlcluster 16 main start >/dev/null 2>&1 || echo "   (已在运行或改用 docker compose up -d)"
fi

echo "==> mock SSO (App 后端) :5555"
pkill -f "mocks/sso/server.js" 2>/dev/null || true
nohup node "$ROOT/mocks/sso/server.js" > "$LOGDIR/mock-sso.log" 2>&1 &

echo "==> mock IM (团队机器人中转) :5566"
pkill -f "mocks/im/server.js" 2>/dev/null || true
nohup node "$ROOT/mocks/im/server.js" > "$LOGDIR/mock-im.log" 2>&1 &

sleep 1
echo "==> NodeBB :4567"
( cd "$NBB" && ./nodebb start )

echo ""
echo "论坛：      http://localhost:4567"
echo "mock SSO：  http://127.0.0.1:5555/_users"
echo "mock IM：   http://127.0.0.1:5566/im/received"
echo "日志目录：  $LOGDIR"
