// =========================================================
// Backs hardware-curves.html: step 3 of the CAPTURE-Screen workflow. Lists every saved curve with
// what it is valid for (biosensor strain, config, signal), marks whether it can
// convert readings on the instrument as it is now, and starts a measurement batch with one.
// The instrument is polled like Calibrate's, so "usable" follows it without a reload. A curve's
// Details draw it over its run's tubes.
// Target elements: #curves-status / #curves-empty / #curves-table-wrapper / #curves-table-body
// Backing API: listCurves / getDeviceStatus / getCurrentSignal / getCalibrationPlan
//
// A saved curve never changes, and there is no "active" curve: Measure asks which curve to use
// at the start of every batch, so two strains can't be mixed up.
// =========================================================

let curvesList = [];
let curvesLoaded = false;
let curvesFingerprint = null;
let curvesSignal = null;
let curvesDeviceError = null;     // why the instrument can't be checked, in words; null while it answers
const openCurveDetails = new Set();
const curvePlans = new Map();     // plan_id -> CalibrationPlan, or null when the run isn't in this browser
const curveCharts = new Map();    // curve_id -> the Chart in its open Details

const CURVES_COLUMN_COUNT = 8;

// The instrument's config and the current signal decide which curves are usable. Polled every
// DEVICE_STATUS_POLL_INTERVAL_MS, and the table re-rendered only when either changes, so an
// instrument coming online turns "Unverified" into "Usable" without a reload.
async function refreshCurvesDevice() {
  const [statusResult, signalResult] = await Promise.allSettled([
    HardwareApi.getDeviceStatus(),
    HardwareApi.getCurrentSignal(),
  ]);
  const fingerprint = statusResult.status === "fulfilled" ? statusResult.value.config.fingerprint : null;
  const signal = signalResult.status === "fulfilled" ? signalResult.value : null;
  const error = statusResult.status === "rejected" ? statusResult.reason.message : null;
  const changed = fingerprint !== curvesFingerprint || signal !== curvesSignal || error !== curvesDeviceError;
  curvesFingerprint = fingerprint;
  curvesSignal = signal;
  curvesDeviceError = error;
  if (!changed || !curvesLoaded) return;
  renderCurvesStatus();
  renderCurves();
}

function renderCurvesStatus() {
  const statusEl = document.getElementById("curves-status");
  if (curvesFingerprint === null) {
    setHardwareStatus(statusEl,
      `Can't check curves against the instrument: ${hwClause(curvesDeviceError)}.`, "warn");
    return;
  }
  statusEl.textContent = "";
  statusEl.append("The instrument now runs config ", hwFingerprint(curvesFingerprint),
    curvesSignal ? `, signal ${curvesSignal}.` : ".");
  statusEl.className = "status-message";
}

async function loadCurves() {
  const statusEl = document.getElementById("curves-status");
  // Curves live in the browser: they still list when the device is unreachable, just unverified.
  const [curvesResult] = await Promise.allSettled([HardwareApi.listCurves(), refreshCurvesDevice()]);
  if (curvesResult.status === "rejected") {
    console.error("Failed to load curves:", curvesResult.reason);
    setHardwareStatus(statusEl, `Couldn't load curves: ${curvesResult.reason.message}`, "error");
    return;
  }
  curvesList = curvesResult.value;
  curvesLoaded = true;
  renderCurvesStatus();
  renderCurves();
}

function renderCurves() {
  document.getElementById("curves-empty").hidden = curvesList.length > 0;
  document.getElementById("curves-table-wrapper").hidden = curvesList.length === 0;

  for (const chart of curveCharts.values()) chart.destroy();
  curveCharts.clear();
  const tbody = document.getElementById("curves-table-body");
  tbody.innerHTML = "";

  for (const curve of curvesList) {
    const blocked = curveBlockReason(curve, curvesFingerprint, curvesSignal);

    const statusCell = hwEl("td");
    if (curvesFingerprint === null) statusCell.appendChild(hwEl("span", "flag-chip", "Unverified"));
    else statusCell.appendChild(hwEl("span", `flag-chip ${blocked ? "error" : "ok"}`, blocked ? "Not usable" : "Usable"));
    if (blocked && curvesFingerprint !== null) statusCell.append(" ", hwEl("span", "cell-note", blocked));

    const actions = hwEl("td", "action-cell");
    if (!blocked) {
      actions.append(hwLink(`hardware-measure.html?curve=${encodeURIComponent(curve.curve_id)}`, "Measure"), " ");
    }
    const open = openCurveDetails.has(curve.curve_id);
    const details = hwEl("button", "btn-secondary table-button", open ? "Hide details" : "Details");
    details.type = "button";
    details.setAttribute("aria-expanded", String(open));
    details.addEventListener("click", () => {
      if (open) openCurveDetails.delete(curve.curve_id);
      else openCurveDetails.add(curve.curve_id);
      renderCurves();
    });
    actions.appendChild(details);

    const configCell = hwEl("td");
    configCell.append(hwFingerprint(curve.config_fingerprint), ` ${curve.signal}`);

    const row = hwEl("tr");
    row.append(
      hwEl("td", null, curve.curve_id),
      hwEl("td", null, curve.conditions.sensor),
      hwEl("td", null, formatConcentration(curve.params.ec50_nM)),
      hwEl("td", null, formatConcentration(curve.lod_nM)),
      hwEl("td", null, formatConcentrationInterval([curve.range_nM.min, curve.range_nM.max])),
      configCell,
      statusCell,
      actions,
    );
    tbody.appendChild(row);

    if (open) tbody.appendChild(renderCurveDetails(curve));
  }
}

function renderCurveDetails(curve) {
  const row = hwEl("tr", "detail-row");
  const cell = hwEl("td");
  cell.colSpan = CURVES_COLUMN_COUNT;

  const grid = hwEl("div", "detail-grid");
  const item = (label, value) => {
    const box = hwEl("div");
    const valueEl = hwEl("span", "detail-value");
    if (value instanceof Node) valueEl.appendChild(value);
    else valueEl.textContent = value;
    box.append(hwEl("span", "sensor-stat-label", label), valueEl);
    grid.appendChild(box);
  };
  item("Model", curve.model);
  item("Top", `${formatFluorescence(curve.params.top)} ${HARDWARE_FLUORESCENCE_UNIT}`);
  item("Bottom", `${formatFluorescence(curve.params.bottom)} ${HARDWARE_FLUORESCENCE_UNIT}`);
  item("EC50", formatConcentration(curve.params.ec50_nM));
  item("Hill slope", curve.params.hill.toFixed(2));
  item("LOD", formatConcentration(curve.lod_nM));
  item("LOQ", formatConcentration(curve.loq_nM));
  item("RMSE", `${formatFluorescence(curve.rmse)} ${HARDWARE_FLUORESCENCE_UNIT}`);
  item("Fitted", formatLocalTime(curve.fitted_at));
  item("Source", curve.source === "manual" ? "Recorded data" : "Instrument");
  item("Run", hwLink(`hardware-calibration.html?plan=${encodeURIComponent(curve.plan_id)}`, curve.plan_id));
  if (curve.conditions.notes) item("Notes", curve.conditions.notes);
  cell.appendChild(grid);
  cell.appendChild(hwBasisNote("cell-note"));
  fillBasisNotes(cell);

  cell.appendChild(hwEl("p", "detail-heading", "Curve"));
  const note = hwEl("p", "chart-note",
    "Blanks (0 nM) aren't drawn.");
  const plate = hwEl("div", "chart-plate curve-chart");
  const canvas = hwEl("canvas");
  plate.appendChild(canvas);
  cell.append(note, plate);
  drawCurveChart(curve, canvas, plate);

  cell.appendChild(hwEl("p", "detail-heading", `Excluded tubes (${curve.excluded.length})`));
  if (curve.excluded.length === 0) {
    cell.appendChild(hwEl("p", "cell-note", "None"));
  } else {
    const list = hwEl("ul", "excluded-list");
    for (const { sample_id, reason } of curve.excluded) {
      const li = hwEl("li");
      li.append(hwEl("b", null, sample_id), `: ${reason}`);
      list.appendChild(li);
    }
    cell.appendChild(list);
  }

  row.appendChild(cell);
  return row;
}

// The curve over its run's tubes. The curve doesn't keep the points it was fitted on, so they come
// from its run, loaded once per run; a tube re-read after the fit is said, since its point is then
// not the one the curve was fitted to.
async function drawCurveChart(curve, canvas, plate) {
  if (!curvePlans.has(curve.plan_id)) {
    let plan = null;
    try {
      plan = await HardwareApi.getCalibrationPlan(curve.plan_id);
    } catch (err) {
      console.error(`Could not load run ${curve.plan_id}:`, err);
    }
    curvePlans.set(curve.plan_id, plan);
  }
  if (!canvas.isConnected) return; // the table was re-rendered while the run loaded
  const plan = curvePlans.get(curve.plan_id);
  if (!plan) {
    plate.replaceChildren(hwEl("p", "cell-note", `Run ${curve.plan_id} isn't in this browser, so its tubes can't be drawn.`));
    return;
  }

  const fluor = cssVar("--fluor");
  const gold = cssVar("--gold");
  const ink = cssVar("--text");
  const muted = cssVar("--muted");
  const rule = cssVar("--border");

  const excludedIds = new Set(curve.excluded.map((e) => e.sample_id));
  const standards = plan.items.filter((it) => it.sample_type === "standard" && it.measurement);
  const toPoint = (it) => ({ x: it.concentration_nM, y: it.measurement.fluorescence });
  const included = standards.filter((it) => !excludedIds.has(it.measurement.sample_id)).map(toPoint);
  const excluded = standards.filter((it) => excludedIds.has(it.measurement.sample_id)).map(toPoint);

  // Drawn only across the standards, like Calibrate's: beyond them would be extrapolating.
  const concs = standards.map((it) => it.concentration_nM);
  const lo = Math.log10(Math.min(...concs));
  const hi = Math.log10(Math.max(...concs));
  const steps = 160;
  const curvePoints = Array.from({ length: steps + 1 }, (_, i) => {
    const x = 10 ** (lo + ((hi - lo) * i) / steps);
    return { x, y: fourPL(x, curve.params) };
  });
  const allY = [...included, ...excluded, ...curvePoints].map((p) => p.y);

  curveCharts.set(curve.curve_id, new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [
        { label: "Tube (counted)", data: included, pointRadius: 3, pointBackgroundColor: fluor, pointBorderColor: fluor },
        {
          label: "Tube (excluded)", data: excluded, pointRadius: 4.5, pointBackgroundColor: "rgba(0,0,0,0)",
          pointBorderColor: muted, pointBorderWidth: 1.5,
        },
        { label: "4PL fit", data: curvePoints, type: "line", pointRadius: 0, borderWidth: 2, tension: 0, borderColor: gold },
        {
          label: "EC50",
          data: [{ x: curve.params.ec50_nM, y: Math.min(...allY) }, { x: curve.params.ec50_nM, y: Math.max(...allY) }],
          type: "line", pointRadius: 0, borderWidth: 1.5, borderDash: [6, 4], borderColor: muted,
        },
      ],
    },
    options: {
      responsive: true,
      aspectRatio: 2.4,
      animation: false,
      scales: {
        x: {
          type: "logarithmic",
          title: { display: true, text: "Concentration (nM, log scale)", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
        y: {
          title: { display: true, text: `${curve.signal} (${HARDWARE_FLUORESCENCE_UNIT})`, color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
      },
      plugins: { legend: { labels: { color: ink } } },
    },
  }));

  const reread = plan.items.filter((it) => it.measurement && it.measurement.timestamp_utc > curve.fitted_at).length;
  if (reread > 0) {
    plate.after(hwEl("p", "cell-note",
      `${plural(reread, "tube")} of this run ${reread === 1 ? "was" : "were"} re-read after the fit; the dots show the current readings.`));
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

document.addEventListener("DOMContentLoaded", () => {
  loadCurves();
  setInterval(refreshCurvesDevice, DEVICE_STATUS_POLL_INTERVAL_MS);
});
