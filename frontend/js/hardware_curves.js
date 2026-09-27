// =========================================================
// Backs hardware-curves.html: step 3 of the CAPTURE-Screen workflow. Lists every saved curve with
// what it is valid for (biosensor strain, induction time, config, signal), marks whether it can
// convert readings on the instrument as it is now, and starts a measurement batch with one.
// Target elements: #curves-status / #curves-empty / #curves-table-wrapper / #curves-table-body
// Backing API: listCurves / getDeviceStatus / getCurrentSignal
//
// A saved curve never changes, and there is no "active" curve: Measure asks which curve to use
// at the start of every batch, so two strains or two induction times can't be mixed up.
// =========================================================

let curvesList = [];
let curvesFingerprint = null;
let curvesSignal = null;
const openCurveDetails = new Set();

const CURVES_COLUMN_COUNT = 9;

async function loadCurves() {
  const statusEl = document.getElementById("curves-status");
  // Curves live in the browser: they still list when the device is unreachable, just unverified.
  const [curvesResult, statusResult, signalResult] = await Promise.allSettled([
    HardwareApi.listCurves(),
    HardwareApi.getDeviceStatus(),
    HardwareApi.getCurrentSignal(),
  ]);
  if (curvesResult.status === "rejected") {
    console.error("Failed to load curves:", curvesResult.reason);
    setHardwareStatus(statusEl, `Could not load curves: ${curvesResult.reason.message}`, "error");
    return;
  }

  curvesList = curvesResult.value;
  curvesFingerprint = statusResult.status === "fulfilled" ? statusResult.value.config.fingerprint : null;
  curvesSignal = signalResult.status === "fulfilled" ? signalResult.value : null;
  renderCurves();
  if (curvesFingerprint === null) {
    setHardwareStatus(statusEl,
      `Instrument unreachable (${statusResult.reason.message}), so it can't be checked which curves match its config.`, "warn");
  } else {
    statusEl.textContent = "";
    statusEl.append("The instrument runs config ", hwFingerprint(curvesFingerprint),
      curvesSignal ? `, signal ${curvesSignal}.` : ".");
    statusEl.className = "status-message";
  }
}

function renderCurves() {
  document.getElementById("curves-empty").hidden = curvesList.length > 0;
  document.getElementById("curves-table-wrapper").hidden = curvesList.length === 0;

  const tbody = document.getElementById("curves-table-body");
  tbody.innerHTML = "";

  for (const curve of curvesList) {
    const blocked = curveBlockReason(curve, curvesFingerprint, curvesSignal);

    const statusCell = hwEl("td");
    if (curvesFingerprint === null) statusCell.appendChild(hwEl("span", "flag-chip", "unverified"));
    else statusCell.appendChild(hwEl("span", `flag-chip ${blocked ? "error" : "ok"}`, blocked ? "not usable" : "usable"));
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
      hwEl("td", null, formatHours(curve.conditions.induction_h)),
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

document.addEventListener("DOMContentLoaded", () => {
  loadCurves();
});
