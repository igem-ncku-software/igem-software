# 同時啟動後端 (127.0.0.1:8000) 與前端靜態伺服器 (127.0.0.1:5500)。
# 用法（在 repo 根目錄）：powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
# 按 Ctrl+C 會把兩個伺服器一起關掉。
#
# 前端的 5500 port 不能隨便換：js/config.js 靠 hostname 判斷要打哪個後端，
# 而 5500 已經在後端的 CORS 白名單裡（backend/app/config.py）。
#
# 注意：這個檔必須存成「UTF-8 with BOM」。Windows PowerShell 5.1 讀 .ps1
# 時沒有 BOM 就會用系統 ANSI 編碼解讀，中文註解會變亂碼並導致語法錯誤。
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root "backend\.venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Error "找不到 backend\.venv，請先執行 scripts\setup.ps1"
}

# 前端放背景，後端跑前景 —— 這樣 Ctrl+C 直接送給 uvicorn，uvicorn 結束後
# 才輪到 finally 收掉前端。跟 scripts/dev.sh 是同一套結構。
Write-Host "==> 前端  http://127.0.0.1:5500"
$frontend = Start-Process -FilePath $py `
    -ArgumentList "-m", "http.server", "5500" `
    -WorkingDirectory (Join-Path $root "frontend") `
    -NoNewWindow -PassThru

try {
    Write-Host "==> 後端  http://127.0.0.1:8000  (API 文件 /docs)"
    Write-Host ""
    Write-Host "兩個伺服器都起來了，Ctrl+C 結束。"
    Write-Host ""
    Push-Location (Join-Path $root "backend")
    & $py -m uvicorn app.main:app --reload --port 8000
} finally {
    Pop-Location -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "==> 關閉前端伺服器"
    if ($frontend -and -not $frontend.HasExited) {
        # /T 連子行程一起收；http.server 本身沒有子行程，但用 /T 比較保險。
        taskkill /PID $frontend.Id /T /F 2>&1 | Out-Null
    }
}
