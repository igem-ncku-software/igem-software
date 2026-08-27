# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

iGEM NCKU Software: a frontend/backend-split web app for the team's wet-lab data tools (fluorescence CSV analysis, ESP32 sensor monitoring). The two halves deploy independently and only talk to each other over HTTP/CORS — there is no shared build step, monorepo tooling, or shared types.

- `frontend/` — static HTML/CSS/vanilla JS, no framework, no bundler. Deployed as-is to GitHub Pages.
- `backend/` — FastAPI app. Deployed to Render at `https://igem-ncku-software.onrender.com`.

## Commands

### Backend (from `backend/`)

```bash
# setup
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt

# run dev server (reload on change)
uvicorn app.main:app --reload
```

Because `main.py` lives inside the `app` package, it must be run as `app.main:app` — running `python main.py` or `uvicorn main:app` directly will fail.

`pytest` is listed in `requirements.txt` but there is currently no `tests/` directory in the working tree (a prior `backend/tests/` with fluorescence/hardware tests was removed) — check `git status`/`git log` before assuming test coverage exists.

### Frontend

No build step. Open `frontend/index.html` directly or serve the folder with any static server (e.g. VS Code Live Server on port 5500 — that origin is already whitelisted in CORS, see below).

## Architecture

### Backend: feature-per-folder under `app/`

Each feature lives in its own folder under `backend/app/`, containing at minimum a `router.py` that defines an `APIRouter` with its own path prefix; feature-specific logic (data validation, computation) goes in sibling modules (e.g. `analysis.py`). The router is then imported and mounted in `backend/app/main.py` via `app.include_router(...)`. There is no shared base class or plugin registry — wiring a new feature in means adding the import + `include_router` line by hand.

Current features:
- `app/fluorescence/` — prefix `/api/fluorescence`. `router.py` handles CSV upload (`POST /analyze`), writes it to a temp file, and delegates to `analysis.py`, which uses pandas to validate the CSV (required columns, numeric ranges, duplicate detection, a mandatory "Control" sample) and compute normalized GFP (`gfp / od600`), per-group means/SD, inhibition rate relative to Control, and statistical significance via Welch's t-test (`scipy.stats.ttest_ind`, `equal_var=False`). Returns `summary` / `results` / `raw_data` / `chart_data` for direct use by Chart.js on the frontend.
- `app/hardware/` — prefix `/api/hardware`. Minimal: `POST /upload` (ESP32 pushes a sensor reading) and `GET /latest` (frontend polls it). State is a single in-memory dict (`latest_data`), not persisted — restarting the server loses it. No history/database yet.
- `app/model/` — prefix `/api/model`. Scaffold only (empty `router.py` with no endpoints yet) — this is where the iGEM mathematical/computational model will live.

When adding a new feature, follow this same pattern (own folder under `app/`, own `router.py` + prefix, mounted in `main.py`) rather than adding routes directly to `main.py`.

### Config

`app/config.py` loads `backend/.env` via `python-dotenv` (silently no-ops if absent, e.g. on Render where env vars are injected by the platform) and centralizes `CORS_ORIGINS` (comma-separated). Default allowed origins cover the GitHub Pages URL plus common local dev ports (5500, 8000). Any new local frontend port needs to be added here or to `.env`.

### Frontend wiring caveats (verified inconsistencies as of last review)

The frontend has two independent entry points that are not fully consistent with each other or with the backend — check current behavior before relying on either:

- `index.html` loads only `js/fluorescence.js`. That file's ESP32 polling code calls `${BACKEND_URL}/esp32/data`, `/esp32/records`, `/esp32/uploads/{id}` — endpoints that do not exist in `app/hardware/router.py` (which only exposes `/api/hardware/upload` and `/api/hardware/latest`). The "ESP32 Live Sensor Data" / "ESP32 Upload Records" sections on the main page are likely non-functional against the current backend.
- `js/hardware.js` (loaded only by the separate `hardware.html` test page) correctly calls `/api/hardware/latest`, but targets DOM ids (`sensor-latest-value`, `sensor-chart`, `backend-status`, …) that belong to `index.html`, not to `hardware.html` (which uses different ids: `sensor-value`, `sensor-device`, `sensor-time`, `sensor-status`).

If asked to fix ESP32/hardware live data, expect to reconcile these three pieces (backend route, and both JS files' expectations) rather than assume any one of them is the current source of truth.

### Deployment

`.github/workflows/deploy-pages.yml` uploads the entire `frontend/` folder as a GitHub Pages artifact on every push to `main` — no build/transform step runs. Backend deployment to Render is external to this repo (no Render config file present here).
