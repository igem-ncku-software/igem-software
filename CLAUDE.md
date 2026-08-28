# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

iGEM NCKU Software: a frontend/backend-split web app for the team's wet-lab data tools (AHL dose-response 4PL curve fitting, ESP32 sensor monitoring). The two halves deploy independently and only talk to each other over HTTP/CORS — there is no shared build step, monorepo tooling, or shared types.

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

`pytest` is listed in `requirements.txt` but there is currently no `tests/` directory in the working tree (a prior `backend/tests/` with dose_response/hardware tests was removed) — check `git status`/`git log` before assuming test coverage exists.

`app/dose_response/` and `app/hardware/` are being rewritten from scratch — as of the last review their folders were empty (only `__init__.py`/`router.py` etc. deleted, unstaged) while `main.py` still imports both routers, so `uvicorn app.main:app` fails with `ModuleNotFoundError` until the rewrite lands. Check `git status` before assuming either module is importable.

### Frontend

No build step. Open `frontend/index.html` directly or serve the folder with any static server (e.g. VS Code Live Server on port 5500 — that origin is already whitelisted in CORS, see below).

## Architecture

### Backend: feature-per-folder under `app/`

Each feature lives in its own folder under `backend/app/`, containing at minimum a `router.py` that defines an `APIRouter` with its own path prefix; feature-specific logic (data validation, computation) goes in sibling modules (e.g. `analysis.py`). The router is then imported and mounted in `backend/app/main.py` via `app.include_router(...)`. There is no shared base class or plugin registry — wiring a new feature in means adding the import + `include_router` line by hand.

Current features (both mid-rewrite — see the note in Commands above; the description below is of the pre-rewrite implementation, kept as a reference for the intended shape):
- `app/dose_response/` — prefix `/api/dose_response`. `POST /fit` takes `{concentrations, responses, fix_bottom?}` and fits a 4-parameter logistic curve (`fitting.py`, via `scipy.optimize`), returning params (`top`/`bottom`/`ec50`/`hill_slope`), std errors, 95% CIs, R², convergence, warnings, and Chart.js-ready `chart_data` (`chart_data.py`). `POST /simulate` (`simulate.py`) generates synthetic concentration/response pairs from given 4PL params + noise, for trying the pipeline before real wet-lab dose-gradient data exists.
- `app/hardware/` — prefix `/api/hardware`. Minimal: `POST /upload` (ESP32 pushes a sensor reading) and `GET /latest` (frontend polls it). State is a single in-memory dict (`latest_data`), not persisted — restarting the server loses it. No history/database yet.

When adding a new feature, follow this same pattern (own folder under `app/`, own `router.py` + prefix, mounted in `main.py`) rather than adding routes directly to `main.py`.

### Config

`app/config.py` loads `backend/.env` via `python-dotenv` (silently no-ops if absent, e.g. on Render where env vars are injected by the platform) and centralizes `CORS_ORIGINS` (comma-separated). Default allowed origins cover the GitHub Pages URL plus common local dev ports (5500, 8000). Any new local frontend port needs to be added here or to `.env`.

### Frontend wiring

`index.html` is the only page and loads two independent scripts, each owning one section of the page and matching it against the pre-rewrite backend contract above:

- `js/hardware.js` — polls `GET /api/hardware/latest` every 2s, renders into the "ESP32 Live Sensor Data" card (`#sensor-latest-value`, `#sensor-latest-name`, `#sensor-latest-time`, a Chart.js line chart in `#sensor-chart`, live/offline state via `#sensor-live-badge` / `#backend-status`). Hardcodes the Render URL — no local/prod branching.
- `js/dose_response.js` — drives the "AHL Dose-Response (4PL) Analysis" card: submits `#dose-response-form` to `POST /api/dose_response/fit`, "Generate simulated data" button to `POST /api/dose_response/simulate` (then auto-runs a fit on the result), and renders params/warnings/a Chart.js scatter+fit-curve+EC50-line chart. Branches backend URL on `window.location.hostname` (`localhost`/`127.0.0.1` → `http://127.0.0.1:8000`, else the Render URL).

Both scripts' DOM ids and endpoint calls matched `index.html` and the backend routes as of the last review — but since the backend routers are mid-rewrite (see Commands), re-verify both against whatever the new `router.py` files expose before assuming this wiring still holds.

### Deployment

`.github/workflows/deploy-pages.yml` uploads the entire `frontend/` folder as a GitHub Pages artifact on every push to `main` — no build/transform step runs. Backend deployment to Render is external to this repo (no Render config file present here).
