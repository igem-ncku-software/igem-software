// =========================================================
// 對接 hardware-curves.html：列出所有已存檔的校正曲線，標出 active /
// available / stale，可以切換 active、展開詳情。
// 目標元素：#curves-status / #curves-empty / #curves-table-wrapper / #curves-table-body
// 對接 API：listCurves / getDeviceStatus / saveCurve（切換 is_active）
// =========================================================

let curvesList = [];
let curvesFingerprint = null;
let curvesBusy = false;
const openCurveDetails = new Set();

const CURVE_STATUS_CHIP = { active: "ok", available: "", stale: "error" };
const CURVES_COLUMN_COUNT = 8;

// stale 優先：組態不符的曲線就算 is_active 也不能用。
function curveStatus(curve) {
  if (curve.config_fingerprint !== curvesFingerprint) return "stale";
  return curve.is_active ? "active" : "available";
}

async function loadCurves(message) {
  const statusEl = document.getElementById("curves-status");
  try {
    const [curves, status] = await Promise.all([HardwareApi.listCurves(), HardwareApi.getDeviceStatus()]);
    curvesList = curves;
    curvesFingerprint = status.config.fingerprint;
    renderCurves();
    if (message) setHardwareStatus(statusEl, message, "success");
    else {
      statusEl.textContent = "";
      statusEl.append("Instrument config is now ", hwFingerprint(curvesFingerprint), ".");
      statusEl.className = "status-message";
    }
  } catch (err) {
    console.error("Failed to load curves:", err);
    setHardwareStatus(statusEl, `Could not load curves: ${err.message}`, "error");
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
  item("Top", `${formatFluorescence(curve.params.top)} counts`);
  item("Bottom", `${formatFluorescence(curve.params.bottom)} counts`);
  item("EC50", formatConcentration(curve.params.ec50_nM));
  item("Hill slope", curve.params.hill.toFixed(2));
  item("LOD", formatConcentration(curve.lod_nM));
  item("LOQ", formatConcentration(curve.loq_nM));
  item("RMSE", `${formatFluorescence(curve.rmse)} counts`);
  item("Usable range", formatConcentrationInterval([curve.range_nM.min, curve.range_nM.max]));
  cell.appendChild(grid);

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
