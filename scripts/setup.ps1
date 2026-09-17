# Sets up the backend environment in one go: creates .venv and installs requirements.txt.
# Usage (from the repo root): powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# The frontend has no dependencies and no build step, so this script only handles the backend.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root "backend")

if (-not (Test-Path ".venv")) {
    Write-Host "==> Creating virtual environment backend\.venv"
    python -m venv .venv
} else {
    Write-Host "==> backend\.venv already exists, reusing it"
}

# Call the venv's python directly without activating, so the script behaves the same in any shell.
$py = Join-Path (Get-Location) ".venv\Scripts\python.exe"

Write-Host "==> Installing dependencies"
& $py -m pip install --upgrade pip --quiet
& $py -m pip install -r requirements.txt

Write-Host ""
Write-Host "Done. Next, run scripts\dev.ps1 to start the frontend and backend."
