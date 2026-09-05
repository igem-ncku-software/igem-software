#!/usr/bin/env bash
# 一次裝好後端環境：建立 .venv 並安裝 requirements.txt。
# 用法（在 repo 根目錄）：bash scripts/setup.sh
#
# 前端沒有依賴、沒有 build step，所以這支只處理後端。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/backend"

if [ ! -d .venv ]; then
  echo "==> 建立虛擬環境 backend/.venv"
  python3 -m venv .venv 2>/dev/null || python -m venv .venv
else
  echo "==> backend/.venv 已存在，沿用"
fi

# 直接叫 venv 裡的 python，不需要先 activate，這樣腳本在哪個 shell 跑都一樣。
PY=".venv/bin/python"
[ -x "$PY" ] || PY=".venv/Scripts/python.exe"   # Windows 的 venv 路徑不一樣

echo "==> 安裝依賴"
"$PY" -m pip install --upgrade pip --quiet
"$PY" -m pip install -r requirements.txt

echo
echo "完成。接著執行 bash scripts/dev.sh 啟動前後端。"
