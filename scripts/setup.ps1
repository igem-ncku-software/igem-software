# 一次裝好後端環境：建立 .venv 並安裝 requirements.txt。
# 用法（在 repo 根目錄）：powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# 前端沒有依賴、沒有 build step，所以這支只處理後端。
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root "backend")

if (-not (Test-Path ".venv")) {
    Write-Host "==> 建立虛擬環境 backend\.venv"
    python -m venv .venv
} else {
    Write-Host "==> backend\.venv 已存在，沿用"
}

# 直接叫 venv 裡的 python，不需要先 activate，這樣腳本在哪個 shell 跑都一樣。
$py = Join-Path (Get-Location) ".venv\Scripts\python.exe"

Write-Host "==> 安裝依賴"
& $py -m pip install --upgrade pip --quiet
& $py -m pip install -r requirements.txt

Write-Host ""
Write-Host "完成。接著執行 scripts\dev.ps1 啟動前後端。"
