# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

LasReader (iGEM NCKU-Tainan 2026): a frontend/backend-split web app for the team's wet-lab data tools (AHL dose-response analysis of plate-reader exports, and the CAPTURE-Screen fluorescence-reader UI). The CAPTURE-Screen reader connects itself to the backend and every hardware page reaches it through the backend; calibration-plan and curve persistence still run in the browser. There is no simulated device anywhere (see the hardware notes below). The two halves deploy independently and talk over HTTP/CORS and WebSocket — there is no shared build step, monorepo tooling, or shared types.

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

`backend/tests/` has 103 tests as of the last run: `tests/dose_response/` (`test_models`, `test_io`, `test_normalize`, `test_timeseries`, `test_doseresponse`, `test_pipeline`, `test_router`) and `tests/hardware/` (`test_hub` drives `DeviceHub` directly through a fake connection; `test_router` goes through `TestClient`; both share device messages from `payloads.py`). `tests/conftest.py` puts `backend/` on `sys.path`, so `pytest` must be run from `backend/`. The hardware router tests hold two sockets (or a socket and an HTTP call) at once, so they enter the `TestClient` as a module-scoped context manager; otherwise each connection runs on its own event loop and the hub's asyncio queues and futures break.

### Firmware (from the repo root)

```bash
arduino-cli compile --fqbn esp32:esp32:esp32doit-devkit-v1 firmware/as7341
```

Compiles cleanly (warnings only from inside the libraries) against ESP32 core 3.3.8, DFRobot_AS7341 1.0.0, Adafruit SSD1306 2.5.17, Adafruit GFX 1.12.6, Adafruit BusIO 1.17.4, ArduinoJson 7.4.3, and WebSockets 2.7.2. The build needs `firmware/as7341/secrets.h` to exist. The Arduino IDE ships its own `arduino-cli.exe` under `resources/app/lib/backend/resources/` in its install folder, so no separate install is needed; pass `--build-path` somewhere outside the repo. Flashing is done by the user.

### Frontend

No build step. Serve the folder with any static server (e.g. `python -m http.server 5500`, or VS Code Live Server — port 5500 is already whitelisted in CORS). Opening the files via `file://` also works, but the pages will hit the Render backend rather than a local one, since `config.js` branches on hostname.

## Architecture

### The spec is the source of truth for dose-response

`docs/dose_response_model_spec.md` defines the math, data schema, module split, and test plan for the dose-response feature. Nearly every module and function in `app/dose_response/` carries a `(spec §N)` reference in its docstring pointing back at a section of that document. **When changing dose-response behavior, read the referenced spec section first** — the code is deliberately a transcription of it, and drifting from the spec silently is worse here than in ordinary code.

### Backend: feature-per-folder under `app/`

Each feature lives in its own folder under `backend/app/`, containing at minimum a `router.py` that defines an `APIRouter` with its own path prefix. The router is then imported and mounted in `backend/app/main.py` via `app.include_router(...)`. There is no shared base class or plugin registry — wiring a new feature in means adding the import + `include_router` line by hand. Follow this same pattern for new features rather than adding routes directly to `main.py`.

The previous ESP32 + GY-302 version (`app/hardware_gy302/`, `/api/hardware_gy302`, and `firmware/gy302_esp32/`) was deleted and survives only in git history.

#### `app/hardware/` — prefix `/api/hardware`

A relay between the one CAPTURE-Screen device and every browser. The backend never dials the device: Render can't reach a device behind a home or lab router. Instead the ESP32 dials out to `WS /device` and keeps that socket open, and browsers only ever talk to the backend:

- `GET /status` — `{online, last_seen, device}`; `device` is the last `DeviceStatus` the firmware reported, kept after it disconnects so pages can say what went offline.
- `POST /read` — the hub sends `{"cmd": "read", "request_id"}` down the device socket and waits for the matching `mode: "measurement"` reply, returning the raw frames. 503 offline, 409 busy, 504 no answer within `HARDWARE_READ_TIMEOUT_SECONDS`, 502 malformed.
- `WS /live` — browser → `{"cmd": "live_start" | "live_stop"}`; server → `mode: "presence"` on connect and on every device status, `mode: "live"` frames only while that browser watches, `mode: "watching"` acks.

`hub.py`'s `DeviceHub` holds all of it in memory, `router.py` is the thin HTTP/WS layer, and `models.py` is the contract with the firmware's JSON and `hardware_processing.js`'s validators (rename a field in all three or none). Rules worth preserving:
- **Online** means a device socket is attached, it has reported a status since attaching, and something arrived within `HARDWARE_ONLINE_TIMEOUT_SECONDS` (the firmware reports every 5 s).
- **The LED streams only while someone watches.** The hub sends `live_start` when the first browser starts watching and `live_stop` when the last one stops or leaves; continuous excitation light heats and bleaches the sample in the cuvette. Keep it viewer-driven.
- One read at a time (an `asyncio.Lock`). A second device connection replaces the first, which is closed with code 4000.
- One backend process (true on Render's free tier); a multi-worker deployment would need a real pub/sub instead of this singleton.
- `/device` echoes the `arduino` subprotocol that arduinoWebSockets requests. **Neither `/device` nor `/read` is authenticated yet**: anyone who finds the URL can pose as the device or trigger reads. The user deferred a shared secret (device `secrets.h` + a Render env var) to later.
- `websockets` must stay in `requirements.txt`: plain `uvicorn` can't serve any WebSocket without it, and `TestClient` doesn't need it, so the tests won't catch its absence.
- `/live` waits on `receive_text()` with a 0.1 s timeout so one coroutine can also drain the viewer's outbox; a two-task version leaked tasks under `TestClient`'s teardown cancellation.

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
- **Uploads are written to a fixed temp filename**, never the client's: `../x` or an absolute name would escape the temp directory.
- **`io.py` decodes by BOM** (UTF-16, UTF-8 with BOM, else UTF-8 with a latin-1 fallback), since Windows instrument software often saves UTF-16. A non-numeric cell (e.g. an overflow marker) raises an error naming the well and time instead of being dropped silently.
- **A condition whose every reading was OD-gated has a NaN plateau** (e.g. growth inhibited at the top dose). `doseresponse.fit_mask()` leaves it out of the Hill fit the same way `[A]=0` is, `flatness_test()` must get that same subset, and `plateau_points` carries `null` for it.

#### `app/dose_response/config/experiment.yaml`

Single source of truth for the plate map (row → AHL concentration, column → strain), blank/positive well roles, and tunable thresholds. `config.py` loads it, and `io.py` / `normalize.py` / `timeseries.py` / `doseresponse.py` each read their defaults from it at import time. **Changing plate layout or a threshold should mean editing this YAML, not a literal in a module.** Note the strain key `DH5α` is spelled with the Unicode alpha to match the data's own `strain` values.

### Config

`app/config.py` loads `backend/.env` via `python-dotenv` (silently no-ops if absent, e.g. on Render where env vars are injected by the platform) and centralizes `CORS_ORIGINS` (comma-separated) plus the hub's `HARDWARE_ONLINE_TIMEOUT_SECONDS` / `HARDWARE_READ_TIMEOUT_SECONDS`. Default allowed origins cover the GitHub Pages URL plus common local dev ports (5500, 8000). Any new local frontend port needs to be added here or to `.env`; `WS /live` checks the same list, since `CORSMiddleware` doesn't cover WebSockets.

### Frontend: flat static pages, one script per page

```
index.html                     entry page: linked cards + live spectrum via /api/hardware
dose-response.html             the analysis UI
hardware.html                  CAPTURE-Screen: instrument status (hardware section home)
hardware-measure.html          CAPTURE-Screen: read a sample, convert through the active curve
hardware-calibration.html      CAPTURE-Screen: create a plan, read standards in slot order
hardware-calibration-fit.html  CAPTURE-Screen: 4PL fit, exclusions with reasons, save/activate
hardware-curves.html           CAPTURE-Screen: all saved curves, active/available/stale
```

Pages are flat files rather than folders (`hardware-measure.html`, not `hardware/measure/`) to match the existing layout and keep relative asset paths one level deep.

Each feature page loads only the script it needs, so a polling loop only runs on the page that shows it. The dose-response page shares nothing but the global `BACKEND_BASE_URL`. The landing page's live spectrum is standalone:

- `js/device_live.js` — the landing-page spectrum. It opens `WS /api/hardware/live` on page load so device presence shows at once, sends `live_start` only while the Live switch is on (off by default; `autocomplete="off"` keeps a reload from switching the LED on), and reconnects with backoff indefinitely, since a sleeping Render backend takes up to a minute to wake. It draws only the latest frame as a bar chart (the user removed the trend line chart; don't add one back) and flags saturated channels. Frames are display-only and never stored; the charts are cleared whenever the device goes offline or the socket drops, never left showing the last frame.

The five hardware workflow pages share a layered stack, loaded in this order after `config.js`:

- `js/hardware_processing.js` — `HardwareProcessing`, **pure functions only** (no DOM, fetch, storage, or clock — time is passed in), meant to be ported verbatim to `backend/app/hardware/`. Turns a `POST /api/hardware/read` response (`dark_1` / `light` / `dark_2` raw ADC counts) into a `Measurement`: dark subtraction (mean of the two darks, clamped ≥ 0), normalization to basic counts `raw / (gain × integration_time_ms)`, saturation at `min(65535, (atime+1)(astep+1))`, unmixing, and the stateless QC flags. Also `configFingerprint()`: a fixed-order, fixed-format hash the backend must reproduce exactly. `toMeasurement()` throws for anything whose `mode` isn't `"measurement"`, so live-stream frames can never be stored or fitted.
- `js/hardware_local.js` — browser-local plan/curve storage, weighted 4PL fit, LOD/LOQ, inversion with a delta-method 95% CI, and the stateful flags (`STALE_CONFIG`/`BELOW_LOD`/`ABOVE_RANGE` for unknowns, the blank-scatter baseline for `HIGH_SCATTER`). It is the temporary persistence backend. Its key is `lasreader.hardware.local.v2`; on load it deletes the v1 keys, which only ever held data from the removed simulated device.
- `js/hardware_api.js` — `HardwareApi`, the only interface workflow pages use, plus JSDoc typedefs for the data contract (`HardwareConfig`, `Measurement`, `CalibrationPlan`, `CalibrationCurve`, `InverseEstimate`, `UnmixBasis`). `getDeviceStatus` / `runDarkRead` / `readSample` call `/api/hardware/status` and `/read`; `getDeviceStatus` throws with a displayable message when the device is offline, so pages treat offline and unreachable alike. Everything else goes to `hardware_local.js`. **Field names in the typedefs are a contract with the future persistence backend — don't rename them.**
- `js/hardware_common.js` — subnav + device badge, number formatting rules (concentration 1 dp and µM above 1000 nM, fluorescence 4 significant figures since basic counts are often < 1, percent 1 dp, local time), flag chips, `setBlocked()` for disabled-with-reason buttons, and the "unmixing basis not calibrated" note for any `[data-basis-note]` element.

**No mock or simulated device exists anywhere — frontend, backend, or firmware — because the user wants real data only.** Don't add one back. To exercise the pages without hardware, run a throwaway script outside the repo that speaks the `WS /api/hardware/device` protocol.

`config/unmix_basis.json` is data, not code: `method: "single_channel"` takes F4 as fluorescence and F3 as scatter. It is a placeholder until an sfGFP standard's spectrum is measured — don't invent basis values or implement least squares before then. While its `version` starts with `placeholder`, every place that shows fluorescence carries the note.

Hardware rules worth preserving: no numeric concentration unless `InverseEstimate.status === "ok"` (never extrapolate outside `range_nM`); excluded tubes stay on the plot and in the data with a reason; disabled buttons always show why; no 4PL parameters in page code. The claims boundary is strict: the pages must not contain diagnostic claims, pathogen-detection wording, or "quantify AHL" — the only exception is the required RUO footer line. (Measure's result card is titled "Inferred AHL" at the user's request; that's an inference label, not a quantification claim.)

The firmware lives in `firmware/as7341/` (ESP32 + AS7341 + SSD1306; DFRobot_AS7341, Adafruit SSD1306/GFX, ArduinoJson 7, and WebSockets by Markus Sattler/Links2004). It runs no HTTP server. After Wi-Fi connects it keeps one outbound `WebSocketsClient` to `BACKEND_HOST` + `/api/hardware/device` and speaks the protocol above: it sends status on connect, on every state change, and every 5 s; streams frames back to back while `liveWanted`; and answers `read` with one dark → light → dark measurement tagged with the `request_id`.
- DFRobot_AS7341 1.0.0 waits ~60 ms per channel register read, so a ten-channel read takes ~1 s (live ≈ 1 frame/s) and a measurement ~3 s, and `loop()` is blocked meanwhile. The pong timeout (10 s) and the backend's 10 s read timeout are sized for that.
- Serial Monitor (115200) prints `[wifi]` / `[backend]` connection events and a "still connecting" line every 10 s — the first place to look when the device doesn't appear online.
- Everything runs in `loop()`. WebSocketsClient callbacks fire inside `ws.loop()`, so there is no concurrency and no mutex; callbacks only record commands (`liveWanted`, `readPending`), and the measurement itself runs in `loop()`.
- State is IDLE / LIVE / MEASURING. LIVE follows `liveWanted` whenever no measurement is running, so a read preempts streaming and streaming resumes afterwards on its own. A backend disconnect clears `liveWanted`, so the LED never stays on with nobody watching.
- `BACKEND_HOST` / `BACKEND_PORT` / `BACKEND_USE_TLS` default to the Render backend and are wrapped in `#ifndef`, so `secrets.h` can point the device at a local backend while an older `secrets.h` holding only Wi-Fi credentials still compiles. Wi-Fi credentials go in `secrets.h`, which is gitignored — copy `secrets.h.example`.
- `setAGAIN()` takes a register index (5 = 16×), not the gain itself.
- `FIRMWARE_VERSION` feeds the config fingerprint, so bumping it makes every existing curve stale — intended when the reading path changes.
- TLS skips certificate validation: with no CA or fingerprint, WebSockets 2.7.2 calls `setInsecure()` on ESP32 (checked in its `WebSocketsClient.cpp`). `beginSslWithCA()` is how to pin Render's root certificate later. Its handshake sends `Origin: file://` and `Sec-WebSocket-Protocol: arduino`, which is why `/device` has no origin check and echoes the subprotocol.

- `js/config.js` — defines `BACKEND_BASE_URL`, branching on hostname (`localhost` / `127.0.0.1` → `http://127.0.0.1:8000`, else Render). Because there's no build step there's no way to inject this at build time, so it's a runtime check kept in one file. **Must be loaded before every other script.**
- `js/dose_response.js` (dose-response.html) — submits the chosen file to `POST /api/dose_response/analyze`, renders the summary table plus a per-strain Chart.js scatter + fit curve + EC50 line, and builds a per-strain "predict concentration" widget that calls `POST /api/dose_response/predict`. Keeps a `strainCharts` map so old Chart instances are `destroy()`ed before a re-analysis. Filters out the `x=0` point (a log axis can't plot it) and any `null` plateau in charts only; the table still shows every strain in full. Draws no curve and offers no predict widget when `responsive` is false.
- `js/hardware.js`, `js/hardware_measure.js`, `js/hardware_calibration.js`, `js/hardware_fit.js`, `js/hardware_curves.js` — one per hardware page, in that page order.
- `js/backend_status.js` (every page) — polls `GET /health` every 12s for the footer badge. It reports whether the backend is up, not whether any hardware is.

CSS is one file, `css/style.css`, with a `:root` variable palette matching the team wiki. JS-generated elements are styled by class name (`.status-message.success` / `.error`, `.result-block`, `.chart-note`, `.predict-form`), so renaming a class means changing both files.

### Deployment

`.github/workflows/deploy-pages.yml` uploads the entire `frontend/` folder as a GitHub Pages artifact on every push to `main` — no build/transform step runs, so new files under `frontend/` are picked up automatically. Backend deployment to Render is external to this repo (no Render config file present here).
