# LasReader

Wet-lab data tools for NCKU-Tainan iGEM 2026 (Capture): a frontend/backend-split web application.

- **AHL dose-response analysis** — upload a raw plate reader export, run the whole analysis pipeline automatically, and get each strain's EC50, Hill coefficient, 95% confidence interval, R², LOD/LOQ, and whether that strain responds to AHL at all.
- **CAPTURE-Screen hardware interface** — the team's own AS7341 fluorescence reader: once the device powers on and joins Wi-Fi it connects itself to the backend, the landing page shows all ten spectral channels live, and four pages, used in order, go through the backend for instrument checks, per-tube calibration with a 4PL fit, and measuring samples in replicate through a chosen curve. Everything shown is a real reading from the device — no simulated data; calibration runs, curves and measurement batches currently live in the browser's localStorage.

The frontend is a plain static site (deployed on GitHub Pages), the backend is FastAPI (deployed on Render), and the two talk over HTTP/CORS and WebSocket — there's no shared build step.

License: [MIT License](LICENSE).

## Architecture

```mermaid
flowchart LR
    FILE["plate reader<br/>export (.txt)"]
    DEV["CAPTURE-Screen<br/>ESP32 + AS7341"]

    subgraph FE["frontend/ — static site (GitHub Pages)"]
        IDX["index.html<br/>entry page + live spectrum"]
        DR["dose-response.html"]
        HW["hardware*.html<br/>CAPTURE-Screen, four steps + Data"]
        LOCAL["js/hardware_local.js<br/>runs, curves & batches (localStorage)"]
        IDX --> DR
        IDX --> HW
        HW --> LOCAL
    end

    subgraph BE["backend/ — FastAPI (Render)"]
        RT1["/api/dose_response<br/>analyze · predict"]
        HUB["/api/hardware<br/>status · read · device"]
        LIVE["/api/live<br/>spectrum"]
        LIVE -->|subscribes to device| HUB
        subgraph PIPE["dose_response analysis pipeline"]
            direction LR
            IO["io"] --> NRM["normalize"] --> TS["timeseries"] --> DRS["doseresponse"]
        end
        RT1 --> PIPE
    end

    FILE --> DR
    DR -->|HTTPS| RT1
    IDX -->|WSS live spectrum| LIVE
    HW -->|HTTPS status & measurement| HUB
    DEV -->|WSS, device dials out| HUB
```

## Project structure

```
frontend/                     plain static site, no framework, no build step
├── index.html                entry page: feature cards + live AS7341 spectrum
├── dose-response.html        dose-response analysis page
├── hardware.html             CAPTURE-Screen step 1: the instrument and its self-checks
├── hardware-calibration.html CAPTURE-Screen step 2: set up a run, read the standards, fit, save a curve
├── hardware-curves.html      CAPTURE-Screen step 3: saved curves and what each is valid for
├── hardware-measure.html     CAPTURE-Screen step 4: read samples in replicate through one curve
├── hardware-data.html        CAPTURE-Screen: backup, restore, reset
├── css/style.css
└── js/                       config / dose_response / backend_status / device_live
                              hardware_processing → hardware_local → hardware_api → hardware_common → each page's script

backend/                      FastAPI
├── app/
│   ├── main.py               mounts each feature's router
│   ├── config.py             environment variables and CORS settings
│   ├── hardware/             CAPTURE-Screen's relay: device connection, status, measurement
│   ├── live/                 live sensing: the shared Live switch and the live spectrum, relayed through hardware's connection
│   └── dose_response/        dose-response analysis (this project's main computation)
├── tests/                    pytest
└── requirements.txt

firmware/capture_screen/      CAPTURE-Screen firmware (ESP32 + AS7341 + OLED + Live button), one sketch plus secrets.h
scripts/                      install and run scripts (.sh and .ps1 versions)
docs/dose_response_model_spec.md   implementation spec for the dose-response model
```

## Quickstart

Requirements: Python 3.10+. The frontend has no dependencies and doesn't need Node.js.

### Using the scripts (recommended)

Run from the repo root. Run setup once to set up the backend environment, then dev every time after that.

```bash
# macOS / Linux / Windows Git Bash
bash scripts/setup.sh
bash scripts/dev.sh
```

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

`dev` starts the backend at http://127.0.0.1:8000 (API docs at `/docs`) and the frontend at http://127.0.0.1:5500 together; Ctrl+C shuts both down.

### Manual steps

If you'd rather not use the scripts, or only want to run one side:

```bash
# Backend
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows; macOS/Linux use source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload

# Frontend (in another terminal)
cd frontend
python -m http.server 5500
```

> `main.py` lives inside the `app` package, so it can **only** be started with `uvicorn app.main:app`. Running `python main.py` or `uvicorn main:app` directly will fail.

Keep the frontend on port 5500 if possible: the backend's CORS allowlist already includes it by default (see `backend/app/config.py`, or override via `backend/.env`). The frontend picks its backend automatically based on the URL — `localhost` / `127.0.0.1` hits the local `http://127.0.0.1:8000`, everything else hits the live Render URL. That check lives in one place, [`frontend/js/config.js`](frontend/js/config.js); changing the URL only means editing that one line.

### Tests

```bash
cd backend
pytest
```

`tests/conftest.py` adds `backend/` to `sys.path`, so `pytest` must be run from inside `backend/`.

## API

Backend URL: `https://igem-ncku-software.onrender.com`

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check; the frontend footer's connection indicator polls this |
| `POST` | `/api/dose_response/analyze` | Upload a reader export (multipart), returns each strain's fitted results |
| `POST` | `/api/dose_response/predict` | Back-calculates AHL concentration from a fluorescence value |
| `GET` | `/api/hardware/status` | Whether CAPTURE-Screen is online, its last reported status and config |
| `POST` | `/api/hardware/read` | Asks the device to take one measurement (dark → light → dark), returns the raw reading |
| `WS` | `/api/hardware/device` | The device's own inbound connection |
| `WS` | `/api/live/spectrum` | The Live switch and the live spectrum, for browsers |

The full request/response schema can be explored interactively at `/docs` once the backend is running.

`/analyze` returns `ec50_nM`, `ec50_nM_ci95`, `n`, `top`, `bottom`, `r_squared`, `responsive`, `p_value`, `lod_nM`, `loq_nM` per strain, plus `plateau_points` and `fit_curve` for plotting.

Two deliberate design choices:

- **When the flatness test decides a strain doesn't respond, `ec50_nM` and `fit_curve` come back `null`** rather than a fake number. The frontend uses this to decide not to draw a curve or offer the inversion tool.
- **`/predict` is stateless**: the frontend sends back the Hill parameters it got from `/analyze` as-is; the backend keeps no session.

## Dose-response analysis pipeline

`app/dose_response/` is implemented per [`docs/dose_response_model_spec.md`](docs/dose_response_model_spec.md), one module per stage:

```
io.py            parses a SpectraMax ASCII export -> a tidy well / time_h / RFU / OD600 table
normalize.py     subtracts blanks, applies OD gating and fluorescence normalization
timeseries.py    collapses replicates, fits the time-axis logistic, extracts the plateau
doseresponse.py  Hill fit (lmfit), flatness test, LOD/LOQ
models.py        pure math (Hill, logistic) — no I/O
pipeline.py      chains the four steps above together
router.py        thin HTTP adapter only, no computation of its own
```

The pure math (`models.py`) is deliberately kept separate from data handling, so it can be unit-tested against synthetic data alone, without needing real experimental data.

Almost every function's docstring in this code is tagged with `(spec §N)`, pointing at the corresponding section of the spec. **Read the referenced spec section before changing analysis behavior** — this code is a deliberate transcription of that spec.

### Experiment design and thresholds

The plate layout (which row is which concentration, which columns are which strain), blank/positive well positions, and every threshold are centralized in [`backend/app/dose_response/config/experiment.yaml`](backend/app/dose_response/config/experiment.yaml).

Design v.1's layout:

- **AHL concentration** (3-oxo-C12-HSL), rows A-F: 0, 1 nM, 10 nM, 100 nM, 1 µM, 10 µM
- **Strains**: TOP10 (columns 1-3), DH5α (columns 4-6), BL21 (columns 7-9)
- **Row G** blank, **H1-H3** positive control
- **Readings**: OD600 + GFP (Ex/Em 485/510 nm), once per hour

To change the plate layout or a threshold, edit this YAML — don't change the numbers inside individual modules.

### Supporting a different plate reader

`io.py`'s `load_reader_export()` is the only place that knows what a SpectraMax ASCII export looks like (an adapter pattern). Everything downstream only consumes the tidy well / time_h / RFU / OD600 table, so supporting a different instrument just means adding a matching `load_*_export()` — no other module needs to change.

## Hardware

CAPTURE-Screen is the team's own fluorescence reader: an ESP32 plus an AS7341 spectral sensor, reading sfGFP fluorescence. Everything shown on the web pages is a real reading from the device — there is no simulated data anywhere; when the device is off, the page shows it as offline directly.

### How the device connects to the software

The backend runs on Render and can't reach a device behind a lab or home router, so the direction is reversed: once the device powers on and joins Wi-Fi, it dials out to `wss://igem-ncku-software.onrender.com/api/hardware/device` itself and keeps that connection open, reconnecting automatically if it drops. Web pages only ever talk to the backend, which relays over that connection to the device:

- **Live spectrum** (landing page, device OLED): Live is one switch, owned by the device and shared by its button (GPIO 13) and the Live switch on every open landing page. Flipping either one turns the LED on and streams frame after frame (about two per second) to every page and to the OLED's bar chart; the device reports the new state straight away, so every switch shows the same thing. Live switches itself off after 10 minutes, since leaving the LED on heats and bleaches the sample; the page shows when. It can't be switched on during a measurement or while the sensor isn't answering.
- **Measurement** (instrument check, calibration, Measure): the page sends `POST /api/hardware/read`, the device runs one dark → light → dark cycle (about 3 s), and the backend hands the raw reading back to the page; dark subtraction, normalization, and unmixing all happen on the web side (`js/hardware_processing.js`). Live streaming pauses during a measurement and resumes automatically afterward.

This connection currently has no authentication: anyone who knows the URL could impersonate the device or trigger a measurement. A shared secret is planned for later.

### Flashing the firmware

1. Install ESP32 board support in the Arduino IDE, plus the libraries DFRobot_AS7341, Adafruit SSD1306, Adafruit GFX, ArduinoJson (7.x), and WebSockets (Markus Sattler). Verified to compile against: ESP32 core 3.3.8, DFRobot_AS7341 1.0.0, Adafruit SSD1306 2.5.17, Adafruit GFX 1.12.6, ArduinoJson 7.4.3, WebSockets 2.7.2.
2. Copy `firmware/capture_screen/secrets.h.example` to `secrets.h` in the same folder, and fill in your Wi-Fi name and password (ESP32 only supports 2.4 GHz). `secrets.h` is excluded by `.gitignore`, so the password never gets committed; the sketch refuses to compile without it.
3. Open `firmware/capture_screen/capture_screen.ino`, select the ESP32 Dev Module board, and flash it.
4. The OLED status bar showing `Web ok` means it's connected, and the landing page's Live card will show `CAPTURE-Screen online`. If it won't connect, open the Serial Monitor (115200) — lines starting with `[wifi]` and `[backend]` explain where it's stuck.

Without a network the button still switches Live, and the OLED shows the spectrum; measurements always come from a web page. The Serial Monitor offers diagnostics only (`?` settings, `i` I2C scan, `b` button, `l` LED, `d` dark/light table, `g`/`t`/`s` sensor settings).

The Render free tier sleeps after a period of inactivity and can take tens of seconds to wake up; the device keeps retrying on its own during that time, no need to reflash or restart it.

### Connecting the device during local development

The backend needs to be reachable from a device on the local network: run `uvicorn app.main:app --host 0.0.0.0 --port 8000` from `backend/`, then in `secrets.h` uncomment `BACKEND_HOST` (filled in with this computer's LAN IP), `BACKEND_PORT 8000`, and `BACKEND_USE_TLS 0`, and reflash.

### Pages

The hardware pages are one workflow used in order. A step bar at the top of every page shows the four steps, the state of each, and which comes next; within a page, numbered step cards do the same, and a step that can't start yet says what it is waiting for.

| Step | Page | Purpose |
|---|---|---|
| 1 Instrument | `hardware.html` | Whether the reader can measure now and, if not, which link failed (backend → device → sensor / LED); its full configuration; a self-check read of a buffer-only cuvette: pass/fail on dark stability and saturation, with the stray-light level and LED signal |
| 2 Calibrate | `hardware-calibration.html` | Set up a run with its conditions (biosensor strain, induction time) → read the standards tube by tube, or enter recorded data → 4PL fit, excluding tubes only with a reason → save the curve |
| 3 Curves | `hardware-curves.html` | Every saved curve, what it is valid for, and whether it matches the instrument now |
| 4 Measure | `hardware-measure.html` | A batch: choose a curve → read a blank → read each sample in replicate tubes → per-sample inferred AHL with a 95% CI, exported as CSV |
| — | `hardware-data.html` | One backup file for runs, curves and batches; restore; delete everything |

Runs, curves, fitting, batches and conversion currently live in the browser's localStorage via `hardware_local.js`, not yet moved to a backend database.

The frontend is layered so that once a storage backend exists, only the API layer needs to change:

- `js/hardware_processing.js` — pure functions: raw device reading → `Measurement` (dark subtraction, normalization, saturation check, unmixing, QC flags, config fingerprint).
- `js/hardware_local.js` — temporary storage for calibration runs, curves and measurement batches, weighted 4PL fitting, LOD/LOQ, inversion with a 95% CI.
- `js/hardware_api.js` — the one interface every hardware page calls: anything device-related goes through the backend, everything else through `hardware_local.js`; also defines the data contract via JSDoc (`Measurement`, `CalibrationPlan`, `CalibrationCurve`, `MeasurementBatch`, `InverseEstimate`, etc.).
- `js/device_live.js` — the landing page's live spectrum: a ten-channel bar chart of the latest frame. Display only, never stores any live frame.

### Backend configuration

`backend/.env` (can be copied from `.env.example`):

```dotenv
# How long without a message from the device before it's considered offline (firmware reports every 5 s)
HARDWARE_ONLINE_TIMEOUT_SECONDS=15
# Upper bound on waiting for one measurement result (a measurement itself takes about 3 s)
HARDWARE_READ_TIMEOUT_SECONDS=10
```

Two rules that must never be broken: **no numeric concentration is ever shown** unless the inversion result is `ok` (never extrapolate outside the range); and the pages **must never contain diagnostic claims, pathogen-detection wording, or a claim to quantify AHL** — the only exception is the required RUO footer line.

## Extending the project

**Adding a backend feature**: create a folder under `backend/app/` containing its own `router.py` (defining an `APIRouter` with its own path prefix), put the computation logic in other modules alongside it, then add one `include_router()` line in `app/main.py`. There's no shared base class or plugin registry — it's wired in by hand. Please don't add routes directly to `main.py`.

**Adding a frontend page**: add an `.html` file under `frontend/`, load `js/config.js` first (it must come before everything else, since it defines `BACKEND_BASE_URL`), then that page's own script, and link to it from `index.html`. Each script only handles its own page and never calls another; the only thing they share is `BACKEND_BASE_URL`. The exception is CAPTURE-Screen's hardware pages, which share `hardware_api.js` and `hardware_common.js` (see the Hardware section above). No deployment config changes are needed — GitHub Actions just uploads the whole `frontend/` folder as-is.

## Dependencies

**Backend** (`backend/requirements.txt`): FastAPI, uvicorn, websockets (needed for uvicorn to handle WebSockets), pydantic, python-multipart, python-dotenv, numpy, scipy, pandas, lmfit, pyyaml; pytest and httpx for testing.

**Firmware** (Arduino Library Manager): DFRobot_AS7341, Adafruit SSD1306, Adafruit GFX, ArduinoJson 7, WebSockets (Markus Sattler).

**Frontend**: only [Chart.js](https://www.chartjs.org/) 4.4.1, loaded via `<script>` from cdnjs — not vendored into the repo, and no npm toolchain.

## Deployment

- **Frontend**: pushing to `main` has [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) upload the whole `frontend/` folder as-is to GitHub Pages, with no build or transform step in between — new files are picked up automatically.
- **Backend**: deployed on Render, configured outside this repo. To let a new frontend origin call the backend, add that origin to `CORS_ORIGINS` (see the defaults in [`backend/app/config.py`](backend/app/config.py), or override via an environment variable).

## License

This project is released under the [MIT License](LICENSE), an OSI-approved open-source license.
