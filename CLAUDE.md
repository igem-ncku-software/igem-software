# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

LasReader (iGEM NCKU-Tainan 2026): a frontend/backend-split web app for the team's wet-lab data tools (AHL dose-response analysis of plate-reader exports, and the CAPTURE-Screen fluorescence-reader UI, whose frontend exists but runs on mock data because its backend is not written yet). The two halves deploy independently and only talk to each other over HTTP/CORS — there is no shared build step, monorepo tooling, or shared types.

- `frontend/` — static HTML/CSS/vanilla JS, no framework, no bundler. Deployed as-is to GitHub Pages.
- `backend/` — FastAPI app. Deployed to Render at `https://igem-ncku-software.onrender.com`.
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

`backend/tests/` covers the dose-response modules (73 tests as of the last run: `test_models`, `test_io`, `test_normalize`, `test_timeseries`, `test_doseresponse`, `test_pipeline`, `test_router`). `tests/conftest.py` puts `backend/` on `sys.path`, so `pytest` must be run from `backend/`.

### Frontend

No build step. Serve the folder with any static server (e.g. `python -m http.server 5500`, or VS Code Live Server — port 5500 is already whitelisted in CORS). Opening the files via `file://` also works, but the pages will hit the Render backend rather than a local one, since `config.js` branches on hostname.

## Architecture

### The spec is the source of truth for dose-response

`docs/dose_response_model_spec.md` defines the math, data schema, module split, and test plan for the dose-response feature. Nearly every module and function in `app/dose_response/` carries a `(spec §N)` reference in its docstring pointing back at a section of that document. **When changing dose-response behavior, read the referenced spec section first** — the code is deliberately a transcription of it, and drifting from the spec silently is worse here than in ordinary code.

### Backend: feature-per-folder under `app/`

Each feature lives in its own folder under `backend/app/`, containing at minimum a `router.py` that defines an `APIRouter` with its own path prefix. The router is then imported and mounted in `backend/app/main.py` via `app.include_router(...)`. There is no shared base class or plugin registry — wiring a new feature in means adding the import + `include_router` line by hand. Follow this same pattern for new features rather than adding routes directly to `main.py`.

`app/hardware/` is currently empty and nothing imports it. The hardware feature is being rewritten there for different hardware with new analysis logic. The previous ESP32 + GY-302 version (`app/hardware_gy302/`, `/api/hardware_gy302`, and `firmware/gy302_esp32/`) was deleted and survives only in git history.

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

### Config

`app/config.py` loads `backend/.env` via `python-dotenv` (silently no-ops if absent, e.g. on Render where env vars are injected by the platform) and centralizes `CORS_ORIGINS` (comma-separated). Default allowed origins cover the GitHub Pages URL plus common local dev ports (5500, 8000). Any new local frontend port needs to be added here or to `.env`.

### Frontend: flat static pages, one script per page

```
index.html                     entry page: two linked cards, no feature API calls
dose-response.html             the analysis UI
hardware.html                  CAPTURE-Screen: instrument status (hardware section home)
hardware-measure.html          CAPTURE-Screen: read a sample, convert through the active curve
hardware-calibration.html      CAPTURE-Screen: create a plan, read standards in slot order
hardware-calibration-fit.html  CAPTURE-Screen: 4PL fit, exclusions with reasons, save/activate
hardware-curves.html           CAPTURE-Screen: all saved curves, active/available/stale
```

Pages are flat files rather than folders (`hardware-measure.html`, not `hardware/measure/`) to match the existing layout and keep relative asset paths one level deep.

Each feature page loads only the script it needs, so a polling loop only runs on the page that shows it. The dose-response page shares nothing but the global `BACKEND_BASE_URL`. The five hardware pages are the exception: they share a three-layer stack, loaded in this order after `config.js`:

- `js/hardware_mock.js` — **the entire hardware backend is currently simulated here.** A 4PL truth model with proportional + additive noise generates every reading. Raw channels, scatter, and QC flags all derive from that one simulation; nothing is a hand-picked random number. It also implements plan/curve storage (localStorage, so state survives across the five pages), a weighted Levenberg–Marquardt 4PL fit, LOD/LOQ, and inversion with a delta-method 95% CI. Pages must never call it directly.
- `js/hardware_api.js` — `HardwareApi`, the only interface pages use, plus JSDoc typedefs for the data contract (`HardwareConfig`, `Measurement`, `CalibrationPlan`, `CalibrationCurve`, `InverseEstimate`). Each function is a mock call with a 300–800 ms delay; swapping in `fetch()` here is meant to require no page changes. **Field names in the typedefs are a contract with the future backend — don't rename them.**
- `js/hardware_common.js` — subnav + device badge, number formatting rules (concentration 1 dp and µM above 1000 nM, fluorescence integer, percent 1 dp, local time), flag chips, `setBlocked()` for disabled-with-reason buttons.
- `js/hardware_mock_panel.js` — a collapsible "Mock controls" card on every hardware page, used to force edge cases (very low/high signal, gain change → stale config, offline, dropped dark frame). It talks to `HardwareMock` directly because a real backend has no such switches; remove it together with `hardware_mock.js` when the backend exists.

Hardware rules worth preserving: no numeric concentration unless `InverseEstimate.status === "ok"` (never extrapolate outside `range_nM`); excluded tubes stay on the plot and in the data with a reason; disabled buttons always show why; no 4PL parameters in page code. The claims boundary is strict: the pages must not contain diagnostic claims, pathogen-detection wording, or "quantify AHL" — the only exception is the required RUO footer line.

- `js/config.js` — defines `BACKEND_BASE_URL`, branching on hostname (`localhost` / `127.0.0.1` → `http://127.0.0.1:8000`, else Render). Because there's no build step there's no way to inject this at build time, so it's a runtime check kept in one file. **Must be loaded before every other script.**
- `js/dose_response.js` (dose-response.html) — submits the chosen file to `POST /api/dose_response/analyze`, renders the summary table plus a per-strain Chart.js scatter + fit curve + EC50 line, and builds a per-strain "predict concentration" widget that calls `POST /api/dose_response/predict`. Keeps a `strainCharts` map so old Chart instances are `destroy()`ed before a re-analysis. Filters out the `x=0` point in charts only (a log axis can't plot it); the table still shows every strain in full. Draws no curve and offers no predict widget when `responsive` is false.
- `js/hardware.js`, `js/hardware_measure.js`, `js/hardware_calibration.js`, `js/hardware_fit.js`, `js/hardware_curves.js` — one per hardware page, in that page order.
- `js/backend_status.js` (every page) — polls `GET /health` every 12s for the footer badge. It reports whether the backend is up, not whether any hardware is.

CSS is one file, `css/style.css`, with a `:root` variable palette matching the team wiki. JS-generated elements are styled by class name (`.status-message.success` / `.error`, `.result-block`, `.chart-note`, `.predict-form`), so renaming a class means changing both files.

### Deployment

`.github/workflows/deploy-pages.yml` uploads the entire `frontend/` folder as a GitHub Pages artifact on every push to `main` — no build/transform step runs, so new files under `frontend/` are picked up automatically. Backend deployment to Render is external to this repo (no Render config file present here).
