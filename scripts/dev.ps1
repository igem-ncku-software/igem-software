# Starts the backend (127.0.0.1:8000) and the frontend static server (127.0.0.1:5500) together.
# Usage (from the repo root): powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
# Ctrl+C shuts down both servers.
#
# The frontend's port 5500 shouldn't be changed casually: js/config.js decides which backend to
# hit based on hostname, and 5500 is already in the backend's CORS allowlist (backend/app/config.py).
#
# Note: this file must be saved as "UTF-8 with BOM". Without a BOM, Windows PowerShell 5.1
# decodes a .ps1 file using the system ANSI codepage, which garbles non-ASCII text into a parse error.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root "backend\.venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Error "backend\.venv not found — run scripts\setup.ps1 first"
}

# Frontend backgrounded, backend foregrounded — this way Ctrl+C goes straight to uvicorn, and
# only once uvicorn exits does the finally block tear down the frontend. Same structure as
# scripts/dev.sh.
Write-Host "==> Frontend  http://127.0.0.1:5500"
$frontend = Start-Process -FilePath $py `
    -ArgumentList "-m", "http.server", "5500" `
    -WorkingDirectory (Join-Path $root "frontend") `
    -NoNewWindow -PassThru

try {
    Write-Host "==> Backend  http://127.0.0.1:8000  (API docs at /docs)"
    Write-Host ""
    Write-Host "Both servers are up. Ctrl+C to stop."
    Write-Host ""
    Push-Location (Join-Path $root "backend")
    & $py -m uvicorn app.main:app --reload --port 8000
} finally {
    Pop-Location -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "==> Stopping frontend server"
    if ($frontend -and -not $frontend.HasExited) {
        # /T also tears down child processes; http.server has none of its own, but /T is cheap insurance.
        taskkill /PID $frontend.Id /T /F 2>&1 | Out-Null
    }
}
