// =========================================================
// Backs hardware-curves.html: lists every saved calibration curve, marking it
// active / available / stale, and lets you switch the active one or expand details.
// Target elements: #curves-status / #curves-empty / #curves-table-wrapper / #curves-table-body
// Backing API: listCurves / getDeviceStatus / saveCurve (to toggle is_active)
// =========================================================

let curvesList = [];
let curvesFingerprint = null;
let curvesBusy = false;
const openCurveDetails = new Set();

const CURVE_STATUS_CHIP = { active: "ok", available: "", stale: "error" };
const CURVES_COLUMN_COUNT = 8;

// Stale takes priority: a curve with a mismatched config can't be used even if is_active.
function curveStatus(curve) {
  if (curve.config_fingerprint !== curvesFingerprint) return "stale";
  return curve.is_active ? "active" : "available";
}

async function loadCurves(message) {
  const statusEl = document.getElementById("curves-status");
  // Curves live in the browser: they still list even when the device is unreachable, just without a stale check.
  const [curvesResult, statusResult] = await Promise.allSettled([HardwareApi.listCurves(), HardwareApi.getDeviceStatus()]);
  if (curvesResult.status === "rejected") {
    console.error("Failed to load curves:", curvesResult.reason);
    setHardwareStatus(statusEl, `Could not load curves: ${curvesResult.reason.message}`, "error");
    return;
  }

  curvesList = curvesResult.value;
  curvesFingerprint = statusResult.status === "fulfilled" ? statusResult.value.config.fingerprint : null;
  renderCurves();
  if (message) {
    setHardwareStatus(statusEl, message, "success");
  } else if (curvesFingerprint === null) {
    setHardwareStatus(statusEl,
      `Instrument unreachable (${statusResult.reason.message}), so it can't be checked which curves match its config.`, "warn");
  } else {
    statusEl.textContent = "";
    statusEl.append("Instrument config is now ", hwFingerprint(curvesFingerprint), ".");
    statusEl.className = "status-message";
  }
}

function renderCurves() {
  document.getElementById("curves-empty").hidden = curvesList.length > 0;
  document.getElementById("curves-table-wrapper").hidden = curvesList.length === 0;

  const tbody = document.getElementById("curves-table-body");
  tbody.innerHTML = "";

  for (const curve of curvesList) {
    const status = curveStatus(curve);

    const statusCell = hwEl("td");
    statusCell.appendChild(hwEl("span", `flag-chip ${CURVE_STATUS_CHIP[status]}`.trim(), status));
    if (status === "stale" && curve.is_active) statusCell.append(" ", hwEl("span", "cell-note", "still marked active"));

    const actions = hwEl("td", "action-cell");
    if (curve.is_active) {
      actions.appendChild(actionButton("Deactivate", () => setCurveActive(curve, false)));
    } else {
      const activate = actionButton("Set active", () => setCurveActive(curve, true));
      if (status === "stale") {
        activate.disabled = true;
        activate.classList.add("is-blocked");
        actions.appendChild(activate);
        actions.appendChild(hwEl("span", "cell-note", "config mismatch"));
      } else {
        actions.appendChild(activate);
      }
    }
    const open = openCurveDetails.has(curve.curve_id);
    const details = actionButton(open ? "Hide details" : "Details", () => {
      if (open) openCurveDetails.delete(curve.curve_id);
      else openCurveDetails.add(curve.curve_id);
      renderCurves();
    });
    details.setAttribute("aria-expanded", String(open));
    actions.appendChild(details);

    const configCell = hwEl("td");
    configCell.appendChild(hwFingerprint(curve.config_fingerprint));

    const row = hwEl("tr");
    row.append(
      hwEl("td", null, curve.curve_id),
      hwEl("td", null, formatLocalTime(curve.fitted_at)),
      hwEl("td", null, formatConcentration(curve.params.ec50_nM)),
      hwEl("td", null, formatConcentration(curve.lod_nM)),
      configCell,
      hwEl("td", null, curve.timepoint),
      statusCell,
      actions,
    );
    tbody.appendChild(row);

    if (open) tbody.appendChild(renderCurveDetails(curve));
  }
}

function actionButton(text, onClick) {
  const button = hwEl("button", "btn-secondary table-button", text);
  button.type = "button";
  button.disabled = curvesBusy;
  button.addEventListener("click", onClick);
  return button;
}

function renderCurveDetails(curve) {
  const row = hwEl("tr", "detail-row");
  const cell = hwEl("td");
  cell.colSpan = CURVES_COLUMN_COUNT;

  const grid = hwEl("div", "detail-grid");
  const item = (label, value) => {
    const box = hwEl("div");
    box.append(hwEl("span", "sensor-stat-label", label), hwEl("span", "detail-value", value));
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
  item("Usable range", formatConcentrationInterval([curve.range_nM.min, curve.range_nM.max]));
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

async function setCurveActive(curve, active) {
  const statusEl = document.getElementById("curves-status");
  curvesBusy = true;
  renderCurves();
  setHardwareStatus(statusEl, active ? `Setting ${curve.curve_id} as active...` : `Deactivating ${curve.curve_id}...`, null);

  try {
    await HardwareApi.saveCurve({ ...curve, is_active: active });
    curvesBusy = false;
    await loadCurves(active ? `${curve.curve_id} is now the active curve.` : `${curve.curve_id} is no longer active.`);
  } catch (err) {
    console.error("Failed to update curve:", err);
    curvesBusy = false;
    renderCurves();
    setHardwareStatus(statusEl, `Could not update ${curve.curve_id}: ${err.message}`, "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadCurves();
});
