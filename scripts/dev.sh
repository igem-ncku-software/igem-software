#!/usr/bin/env bash
# Starts the backend (127.0.0.1:8000) and the frontend static server (127.0.0.1:5500) together.
# Usage (from the repo root): bash scripts/dev.sh
# Ctrl+C shuts down both servers.
#
# The frontend's port 5500 shouldn't be changed casually: js/config.js decides which backend to
# hit based on hostname, and 5500 is already in the backend's CORS allowlist (backend/app/config.py).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PY="$ROOT/backend/.venv/bin/python"
[ -x "$PY" ] || PY="$ROOT/backend/.venv/Scripts/python.exe"   # venv path differs on Windows
if [ ! -x "$PY" ]; then
  echo "backend/.venv not found — run bash scripts/setup.sh first" >&2
  exit 1
fi

# The backend runs in the foreground (see below), so this only needs to tear down the one
# frontend http.server process. There's no subprocess tree to manage, so a plain kill is
# enough and behaves the same on every platform.
# Frontend backgrounded, backend foregrounded — this way Ctrl+C goes straight to uvicorn, and
# once uvicorn exits the script continues and the EXIT trap tears down the frontend. Both are
# deliberately not backgrounded while waiting on a signal: a backgrounded bash on Windows never
# receives the INT from Ctrl+C, so the trap would never fire.
echo "==> Frontend  http://127.0.0.1:5500"
# exec turns the subshell into python itself, so $! is the real python PID;
# otherwise only the outer subshell gets killed and python is orphaned, still holding the port.
(cd "$ROOT/frontend" && exec "$PY" -m http.server 5500 >/dev/null 2>&1) &
FRONTEND_PID=$!

cleanup() {
  echo
  echo "==> Stopping frontend server"
  kill "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Backend  http://127.0.0.1:8000  (API docs at /docs)"
echo
echo "Both servers are up. Ctrl+C to stop."
echo
cd "$ROOT/backend"
"$PY" -m uvicorn app.main:app --reload --port 8000
