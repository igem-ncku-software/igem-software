#!/usr/bin/env bash
# 同時啟動後端 (127.0.0.1:8000) 與前端靜態伺服器 (127.0.0.1:5500)。
# 用法（在 repo 根目錄）：bash scripts/dev.sh
# 按 Ctrl+C 會把兩個伺服器一起關掉。
#
# 前端的 5500 port 不能隨便換：js/config.js 靠 hostname 判斷要打哪個後端，
# 而 5500 已經在後端的 CORS 白名單裡（backend/app/config.py）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PY="$ROOT/backend/.venv/bin/python"
[ -x "$PY" ] || PY="$ROOT/backend/.venv/Scripts/python.exe"   # Windows 的 venv 路徑不一樣
if [ ! -x "$PY" ]; then
  echo "找不到 backend/.venv，請先執行 bash scripts/setup.sh" >&2
  exit 1
fi

# 後端跑前景（見下），所以這裡只需要收掉前端那一個 http.server，
# 沒有子行程要處理，用標準的 kill 就夠，各平台行為一致。
# 前端放背景，後端跑前景 —— 這樣 Ctrl+C 是直接送給 uvicorn，uvicorn 一結束
# 腳本就往下走並觸發 EXIT trap 收掉前端。刻意不讓兩個都放背景再等訊號：
# 背景 bash 在 Windows 上收不到 Ctrl+C 產生的 INT，trap 不會被觸發。
echo "==> 前端  http://127.0.0.1:5500"
# exec 讓 subshell 直接變成 python 本身，$! 才會是真正的 python PID；
# 否則殺掉的只是外層 subshell，python 會變孤兒繼續佔著 port。
(cd "$ROOT/frontend" && exec "$PY" -m http.server 5500 >/dev/null 2>&1) &
FRONTEND_PID=$!

cleanup() {
  echo
  echo "==> 關閉前端伺服器"
  kill "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> 後端  http://127.0.0.1:8000  (API 文件 /docs)"
echo
echo "兩個伺服器都起來了，Ctrl+C 結束。"
echo
cd "$ROOT/backend"
"$PY" -m uvicorn app.main:app --reload --port 8000
