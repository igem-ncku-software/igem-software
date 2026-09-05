# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

iGEM NCKU Software: a frontend/backend-split web app for the team's wet-lab data tools (AHL dose-response analysis of plate-reader exports, ESP32 light-sensor monitoring). The two halves deploy independently and only talk to each other over HTTP/CORS — there is no shared build step, monorepo tooling, or shared types.

- `frontend/` — static HTML/CSS/vanilla JS, no framework, no bundler. Deployed as-is to GitHub Pages.
- `backend/` — FastAPI app. Deployed to Render at `https://igem-ncku-software.onrender.com`.
- `firmware/` — Arduino sketch for the ESP32 + GY-302 sensor node that POSTs to the backend.
- `docs/` — `dose_response_model_spec.md`, the written spec the dose-response backend implements.
- `scripts/` — install and run scripts, `.sh` and `.ps1` versions of each.

### iGEM constraints

This is an iGEM competition entry, which imposes two requirements on the repo itself: the software must be **released under an OSI-approved open-source license** (done — MIT, see `LICENSE`), and the source **must be hosted on the team's repository on iGEM's own GitLab** (`gitlab.igem.org`). This GitHub repo is not that; keeping the iGEM GitLab copy in sync is a manual step outside this repo. Judging also weighs documentation quality for future teams — code comments, architecture diagrams, and install/run scripts — which is why `scripts/` and the README's diagram exist.

## Commands

### Scripts (from the repo root)

```bash
bash scripts/setup.sh    # create backend/.venv + pip install
bash scripts/dev.sh      # backend on :8000 and frontend on :5500 together
```

PowerShell equivalents are `scripts\setup.ps1` / `scripts\dev.ps1`. Both `dev` scripts run the frontend static server in the background and **uvicorn in the foreground on purpose** — Ctrl+C then reaches uvicorn directly, and the script's exit handler stops the frontend. Backgrounding both instead leaves orphaned servers holding the ports, because a background shell on Windows never receives the interrupt.

The `.ps1` files must stay **UTF-8 with BOM**. Windows PowerShell 5.1 decodes a BOM-less `.ps1` as system ANSI, which mangles the Chinese comments into a parse error.

### Backend (from `backend/`)

```bash
# setup
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt

# run dev server (reload on change)
uvicorn app.main:app --reload

# tests
pytest
```

Because `main.py` lives inside the `app` package, it must be run as `app.main:app` — running `python main.py` or `uvicorn main:app` directly will fail.

`backend/tests/` covers the dose-response modules (73 tests as of the last run: `test_models`, `test_io`, `test_normalize`, `test_timeseries`, `test_doseresponse`, `test_pipeline`, `test_router`). `tests/conftest.py` puts `backend/` on `sys.path`, so `pytest` must be run from `backend/`. There are no tests for `app/hardware_gy302/`.

### Frontend

No build step. Serve the folder with any static server (e.g. `python -m http.server 5500`, or VS Code Live Server — port 5500 is already whitelisted in CORS). Opening the files via `file://` also works, but the pages will hit the Render backend rather than a local one, since `config.js` branches on hostname.

## Architecture

### The spec is the source of truth for dose-response

`docs/dose_response_model_spec.md` defines the math, data schema, module split, and test plan for the dose-response feature. Nearly every module and function in `app/dose_response/` carries a `(spec §N)` reference in its docstring pointing back at a section of that document. **When changing dose-response behavior, read the referenced spec section first** — the code is deliberately a transcription of it, and drifting from the spec silently is worse here than in ordinary code.

### Backend: feature-per-folder under `app/`

Each feature lives in its own folder under `backend/app/`, containing at minimum a `router.py` that defines an `APIRouter` with its own path prefix. The router is then imported and mounted in `backend/app/main.py` via `app.include_router(...)`. There is no shared base class or plugin registry — wiring a new feature in means adding the import + `include_router` line by hand. Follow this same pattern for new features rather than adding routes directly to `main.py`.

`app/hardware/` is an empty leftover directory from a removed feature — nothing imports it. `app/hardware_gy302/` replaced it.

#### `app/dose_response/` — prefix `/api/dose_response`

The one substantial feature. Layered as a pipeline, each stage in its own module, with pure math separated from data handling so the math can be unit-tested against synthetic data alone:

```
io.py            parse SpectraMax ASCII export -> tidy well/time_h/RFU/OD600 table
normalize.py     blank subtraction + OD-gated normalized fluorescence F
timeseries.py    collapse replicates, fit the per-condition time logistic, extract plateau
doseresponse.py  Hill fit (lmfit), flatness test, LOD/LOQ
models.py        pure equations (hill, logistic_time) — no I/O, no fitting
pipeline.py      run_pipeline(): orchestrates io -> normalize -> timeseries -> doseresponse
router.py        thin HTTP adapter; no computation of its own
```

Two endpoints:
- `POST /analyze` — multipart file upload of a raw reader export; runs the whole pipeline and returns `{strains: {name: {ec50_nM, ec50_nM_ci95, n, top, bottom, r_squared, responsive, p_value, lod_nM, loq_nM, plateau_points, fit_curve}}}`.
- `POST /predict` — back-calculates `[AHL]` from a normalized fluorescence value, given a strain's already-fitted Hill params.

Conventions worth preserving:
- **Stateless.** `/predict` takes the Hill params in the request rather than looking up a stored `/analyze` result. There is no session or result storage anywhere in this backend; don't introduce one for a single endpoint.
- **Units.** The internal math works in Molar; the HTTP layer converts to and from nM at the boundary (`router.py`). Field names carry the unit (`ec50_nM` vs `ec50_M`).
- **Non-responsive strains return `None`, not a fake number.** When the flatness test says a strain doesn't respond, `ec50_nM` and `fit_curve` are `None` by design (spec §5.4). The frontend relies on this to decide whether to draw a curve.
- **`_json_safe()`** in `router.py` converts NaN/Infinity to `null`; Python's JSON encoder would otherwise emit tokens that the browser's `JSON.parse` rejects.

#### `app/dose_response/config/experiment.yaml`

Single source of truth for the plate map (row → AHL concentration, column → strain), blank/positive well roles, and tunable thresholds. `config.py` loads it, and `io.py` / `normalize.py` / `timeseries.py` / `doseresponse.py` each read their defaults from it at import time. **Changing plate layout or a threshold should mean editing this YAML, not a literal in a module.** Note the strain key `DH5α` is spelled with the Unicode alpha to match the data's own `strain` values.

#### `app/hardware_gy302/` — prefix `/api/hardware_gy302`

Minimal: `POST /upload` (ESP32 pushes a lux reading) and `GET /latest` (frontend polls it). State is a single in-memory `LatestReading`, not persisted — restarting the server loses it, and a second uploading device overwrites it. No history or database.

### Config

`app/config.py` loads `backend/.env` via `python-dotenv` (silently no-ops if absent, e.g. on Render where env vars are injected by the platform) and centralizes `CORS_ORIGINS` (comma-separated). Default allowed origins cover the GitHub Pages URL plus common local dev ports (5500, 8000). Any new local frontend port needs to be added here or to `.env`.

### Frontend: three static pages, one script per feature

```
index.html            entry page: two linked cards, no feature API calls
dose-response.html    the analysis UI
hardware.html         the live sensor UI
```

Each feature page loads only the script it needs, so the GY-302 2-second polling loop only runs on the page that shows it. Scripts never call each other and share no state; the single coupling point is that they all read the global `BACKEND_BASE_URL`.

- `js/config.js` — defines `BACKEND_BASE_URL`, branching on hostname (`localhost` / `127.0.0.1` → `http://127.0.0.1:8000`, else Render). Because there's no build step there's no way to inject this at build time, so it's a runtime check kept in one file. **Must be loaded before every other script.**
- `js/dose_response.js` (dose-response.html) — submits the chosen file to `POST /api/dose_response/analyze`, renders the summary table plus a per-strain Chart.js scatter + fit curve + EC50 line, and builds a per-strain "predict concentration" widget that calls `POST /api/dose_response/predict`. Keeps a `strainCharts` map so old Chart instances are `destroy()`ed before a re-analysis. Filters out the `x=0` point in charts only (a log axis can't plot it); the table still shows every strain in full. Draws no curve and offers no predict widget when `responsive` is false.
- `js/hardware_gy302.js` (hardware.html) — polls `GET /api/hardware_gy302/latest` every 2s. The backend keeps no history, so the line chart's history is a client-side rolling window (30 points) that resets on reload. Marks the sensor offline if the reading's timestamp is more than 10s old.
- `js/backend_status.js` (all three pages) — polls `GET /health` every 12s for the footer badge. Distinct from the GY-302 badge: this one reports the backend, that one reports the ESP32.

CSS is one file, `css/style.css`, with a `:root` variable palette matching the team wiki. JS-generated elements are styled by class name (`.status-message.success` / `.error`, `.result-block`, `.chart-note`, `.predict-form`), so renaming a class means changing both files.

### Firmware

`firmware/gy302_esp32/gy302_esp32.ino` — reads the BH1750 over I2C, drives an LED against a local lux threshold, and HTTPS-POSTs `{"lux": <float>}` to `/api/hardware_gy302/upload` every 3s. Wi-Fi credentials are blank placeholders at the top of the sketch. The HTTP timeout is deliberately long (20s) because Render's free tier cold-starts slowly.

### Deployment

`.github/workflows/deploy-pages.yml` uploads the entire `frontend/` folder as a GitHub Pages artifact on every push to `main` — no build/transform step runs, so new files under `frontend/` are picked up automatically. Backend deployment to Render is external to this repo (no Render config file present here).
