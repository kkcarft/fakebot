#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  FakeBot 一键启动 (Linux / macOS)"
echo "============================================"
echo

# 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js,请先安装: https://nodejs.org/"
  exit 1
fi

# 首次运行自动安装依赖
if [ ! -d "node_modules" ]; then
  echo "[首次运行] 正在安装依赖,请稍候..."
  npm install --no-audit --no-fund
  echo
fi

node src/index.js