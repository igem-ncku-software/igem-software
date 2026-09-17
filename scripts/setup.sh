#!/usr/bin/env bash
# Sets up the backend environment in one go: creates .venv and installs requirements.txt.
# Usage (from the repo root): bash scripts/setup.sh
#
# The frontend has no dependencies and no build step, so this script only handles the backend.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/backend"

if [ ! -d .venv ]; then
  echo "==> Creating virtual environment backend/.venv"
  python3 -m venv .venv 2>/dev/null || python -m venv .venv
else
  echo "==> backend/.venv already exists, reusing it"
fi

# Call the venv's python directly without activating, so the script behaves the same in any shell.
PY=".venv/bin/python"
[ -x "$PY" ] || PY=".venv/Scripts/python.exe"   # venv path differs on Windows

echo "==> Installing dependencies"
"$PY" -m pip install --upgrade pip --quiet
"$PY" -m pip install -r requirements.txt

echo
echo "Done. Next, run bash scripts/dev.sh to start the frontend and backend."
