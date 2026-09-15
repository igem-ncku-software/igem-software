// =========================================================
// 對接 hardware-calibration-fit.html：用跑完的 calibration plan 擬合 4PL，
// 排除個別管（一定要附理由），存檔後詢問是否設為 active。
//
// 狀態機：
//   unfitted -> 只有 Fit 可用，Save 停用
//   fitted   -> 顯示曲線與指標，Save 可用；改變排除項目退回 unfitted
//   saved    -> 顯示曲線 id，提供前往 Measure 的連結
//
// 被排除的管不會從圖上或表格裡消失：圖上畫成灰色空心，表格留著並帶理由。
//
// 目標元素：#fit-* / #save-* / #saved-* / #activate-* / #refit-button，見 HTML
// 對接 API：getCalibrationPlan / getDeviceStatus / fitCurve / saveCurve
// =========================================================

let fitPlan = null;
let fitDeviceFingerprint = null;
let fitState = "unfitted";
let fitCurveResult = null; // fitCurve / saveCurve 回傳的 CalibrationCurve
let fitBusy = false;
let fitHasFittedOnce = false;
let activatePromptOpen = false;
let fitChart = null;
const fitExclusions = new Map(); // sample_id -> 理由；勾選了就在這裡，理由可能還沒填

const FIT_STATE_CHIP = {
  unfitted: ["Unfitted", ""],
  fitted: ["Fitted", "warn"],
  saved: ["Saved", "ok"],
};

// 誤差棒。Chart.js 沒有內建，外掛是新依賴，所以自己畫：
// 讀 dataset 上的 errorBars: true，每個點的 sd 決定上下長度。
const fitErrorBarPlugin = {
  id: "fitErrorBars",
  afterDatasetsDraw(chart) {
    const { ctx, scales } = chart;
    chart.data.datasets.forEach((dataset, i) => {
      if (!dataset.errorBars || !chart.isDatasetVisible(i)) return;
      ctx.save();
      ctx.strokeStyle = dataset.borderColor;
      ctx.lineWidth = 1.5;
      for (const point of dataset.data) {
        if (!(point.sd > 0)) continue;
        const x = scales.x.getPixelForValue(point.x);
        const top = scales.y.getPixelForValue(point.y + point.sd);
        const bottom = scales.y.getPixelForValue(point.y - point.sd);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.moveTo(x - 5, top);
        ctx.lineTo(x + 5, top);
        ctx.moveTo(x - 5, bottom);
        ctx.lineTo(x + 5, bottom);
        ctx.stroke();
      }
      ctx.restore();
    });
  },
};

function fitMean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function fitSd(values) {
  if (values.length < 2) return 0;
  const m = fitMean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

function formatSignedCounts(value) {
  if (!Number.isFinite(value)) return "--";
  const rounded = Math.round(value) || 0;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

// 依濃度分組（blank 當 0），組內依 slot 排序。
function groupPlanItems(items) {
  const groups = new Map();
  for (const item of items) {
    const c = item.sample_type === "blank" ? 0 : item.concentration_nM;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(item);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([c, groupItems]) => ({ c, items: groupItems.sort((a, b) => a.slot - b.slot) }));
}

function isExcluded(item) {
  return fitExclusions.has(item.measurement.sample_id);
}

function missingReasonCount() {
  return [...fitExclusions.values()].filter((reason) => !reason.trim()).length;
}

// 只有 fitted / saved 才有能畫、能算殘差的曲線。
function currentCurve() {
  return fitState === "unfitted" ? null : fitCurveResult;
}

// ---- 停用原因 --------------------------------------------------------

function blockedFitReason() {
  const pending = fitPlan.items.filter((it) => !it.measurement).length;
  if (pending > 0) return `${pending} of ${fitPlan.items.length} tubes are still unread. Finish the run before fitting.`;
  if (fitState === "fitted") return "Already fitted with these exclusions. Change an exclusion to fit again.";
  if (fitState === "saved") return "This fit is saved. Use “Fit again with different exclusions” below to start a new one.";
  const missing = missingReasonCount();
  if (missing > 0) return `Give a reason for every excluded tube (${missing} missing).`;
  return null;
}

function blockedSaveReason() {
  if (fitState === "unfitted") {
    return fitHasFittedOnce ? "Exclusions changed since the last fit. Fit again before saving." : "Fit the curve first.";
  }
  const missing = missingReasonCount();
  if (missing > 0) return `Give a reason for every excluded tube (${missing} missing).`;
  return null;
}

// ---- 繪製 ------------------------------------------------------------

function renderFitSource() {
  document.getElementById("fit-source").hidden = false;
  document.getElementById("fit-plan-title").textContent = fitPlan.plan_id;

  const total = fitPlan.items.length;
  const read = fitPlan.items.filter((it) => it.measurement).length;
  const tbody = document.getElementById("fit-source-body");
  tbody.innerHTML = "";
  appendKvRow(tbody, "Plan", fitPlan.plan_id);
  appendKvRow(tbody, "Timepoint", fitPlan.timepoint);
  appendKvRow(tbody, "Config fingerprint", hwFingerprint(fitPlan.config_fingerprint));
  appendKvRow(tbody, "Created", formatLocalTime(fitPlan.created_at));
  const tubes = hwEl("span", null, `${read} / ${total} read `);
  if (read < total) tubes.appendChild(hwLink(`hardware-calibration.html?plan=${encodeURIComponent(fitPlan.plan_id)}`, "Back to the run →"));
  appendKvRow(tbody, "Tubes", tubes);

  const warning = document.getElementById("fit-config-warning");
  warning.hidden = fitDeviceFingerprint === fitPlan.config_fingerprint;
  if (!warning.hidden) {
    setHardwareStatus(warning,
      `The instrument now runs config ${fitDeviceFingerprint}, but this plan was read under ${fitPlan.config_fingerprint}. `
      + `A curve fitted from it stays bound to ${fitPlan.config_fingerprint} and cannot be set as active under the current config.`,
      "warn");
  }
}

function renderFitControls() {
  const [stateText, stateKind] = FIT_STATE_CHIP[fitState];
  const chip = document.getElementById("fit-state");
  chip.textContent = stateText;
  chip.className = `flag-chip ${stateKind}`.trim();

  const fitButton = document.getElementById("fit-button");
  setBlocked(fitButton, document.getElementById("fit-reason"), blockedFitReason());
  if (fitBusy) fitButton.disabled = true;

  const saveButton = document.getElementById("save-button");
  saveButton.hidden = fitState === "saved";
  setBlocked(saveButton, document.getElementById("save-reason"), fitState === "saved" ? null : blockedSaveReason());
  if (fitBusy) saveButton.disabled = true;

  const binding = document.getElementById("fit-save-binding");
  binding.textContent = "";
  binding.append("The curve will be bound to config ", hwFingerprint(fitPlan.config_fingerprint),
    ` and timepoint “${fitPlan.timepoint}”.`);

  document.getElementById("saved-panel").hidden = fitState !== "saved";
  if (fitState === "saved") {
    document.getElementById("saved-message").textContent = fitCurveResult.is_active
      ? `Saved as ${fitCurveResult.curve_id}. It is the active curve.`
      : `Saved as ${fitCurveResult.curve_id}.`;
  }
  document.getElementById("activate-prompt").hidden = !activatePromptOpen;
  document.getElementById("activate-button").disabled = fitBusy;
  document.getElementById("skip-activate-button").disabled = fitBusy;
  document.getElementById("refit-button").disabled = fitBusy;
}

function renderFitChart() {
  const canvas = document.getElementById("fit-chart");
  if (fitChart) fitChart.destroy();

  const accent = cssVar("--accent");
  const gold = cssVar("--gold");
  const error = cssVar("--error");
  const ink = cssVar("--text");
  const muted = cssVar("--muted");
  const rule = cssVar("--border");

  const curve = currentCurve();
  const standards = fitPlan.items.filter((it) => it.sample_type === "standard");
  const toPoint = (it) => ({ x: it.concentration_nM, y: it.measurement.fluorescence });
  const included = standards.filter((it) => !isExcluded(it)).map(toPoint);
  const excluded = standards.filter(isExcluded).map(toPoint);

  const means = groupPlanItems(standards)
    .map((group) => ({
      c: group.c,
      ys: group.items.filter((it) => !isExcluded(it)).map((it) => it.measurement.fluorescence),
    }))
    .filter(({ ys }) => ys.length > 0)
    .map(({ ys, c }) => ({ x: c, y: fitMean(ys), sd: fitSd(ys) }));

  const datasets = [
    {
      label: "Tube (included)",
      data: included,
      pointRadius: 3,
      pointBackgroundColor: accent,
      pointBorderColor: accent,
      showLine: false,
    },
    {
      label: "Tube (excluded)",
      data: excluded,
      pointRadius: 4.5,
      pointBackgroundColor: "rgba(0,0,0,0)",
      pointBorderColor: muted,
      pointBorderWidth: 1.5,
      showLine: false,
    },
    {
      label: "Mean ± SD",
      data: means,
      pointStyle: "rect",
      pointRadius: 5,
      pointBackgroundColor: ink,
      pointBorderColor: ink,
      borderColor: ink,
      showLine: false,
      errorBars: true,
    },
  ];

  if (curve) {
    // 曲線只畫在標準品濃度範圍內：畫到範圍外等於在圖上外插。
    const concs = standards.map((it) => it.concentration_nM);
    const lo = Math.log10(Math.min(...concs));
    const hi = Math.log10(Math.max(...concs));
    const steps = 160;
    const curvePoints = Array.from({ length: steps + 1 }, (_, i) => {
      const x = 10 ** (lo + ((hi - lo) * i) / steps);
      return { x, y: fourPL(x, curve.params) };
    });

    const allY = [...included, ...excluded, ...curvePoints].map((p) => p.y)
      .concat(means.flatMap((p) => [p.y - p.sd, p.y + p.sd]));
    datasets.push(
      {
        label: "4PL fit",
        data: curvePoints,
        type: "line",
        pointRadius: 0,
        borderWidth: 2,
        tension: 0,
        borderColor: gold,
      },
      {
        label: "EC50",
        data: [
          { x: curve.params.ec50_nM, y: Math.min(...allY) },
          { x: curve.params.ec50_nM, y: Math.max(...allY) },
        ],
        type: "line",
        pointRadius: 0,
        borderWidth: 1.5,
        borderDash: [6, 4],
        borderColor: error,
      },
    );
  }

  fitChart = new Chart(canvas, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      aspectRatio: 2.2,
      animation: false,
      scales: {
        x: {
          type: "logarithmic",
          title: { display: true, text: "Concentration (nM, log scale)", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
        y: {
          title: { display: true, text: "sfGFP signal · F4 515 nm (counts)", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
      },
      plugins: { legend: { labels: { color: ink } } },
    },
    plugins: [fitErrorBarPlugin],
  });
}

function renderFitMetrics() {
  const curve = currentCurve();
  const set = (id, text) => { document.getElementById(id).textContent = text; };

  if (!curve) {
    ["fit-ec50", "fit-hill", "fit-lod", "fit-rmse"].forEach((id) => set(id, "--"));
    ["fit-ec50-sub", "fit-hill-sub", "fit-lod-sub", "fit-rmse-sub"].forEach((id) => set(id, "Not fitted"));
    return;
  }

  set("fit-ec50", formatConcentration(curve.params.ec50_nM));
  set("fit-ec50-sub", `Usable range ${formatConcentrationInterval([curve.range_nM.min, curve.range_nM.max])}`);
  set("fit-hill", curve.params.hill.toFixed(2));
  set("fit-hill-sub", `Top ${formatFluorescence(curve.params.top)} · bottom ${formatFluorescence(curve.params.bottom)} counts`);
  set("fit-lod", formatConcentration(curve.lod_nM));
  set("fit-lod-sub", `LOQ ${formatConcentration(curve.loq_nM)}`);
  set("fit-rmse", formatFluorescence(curve.rmse));
  set("fit-rmse-sub", "counts");
}

function renderFitTable() {
  const tbody = document.getElementById("fit-table-body");
  tbody.innerHTML = "";
  const curve = currentCurve();
  const locked = fitBusy || fitState === "saved";

  for (const group of groupPlanItems(fitPlan.items)) {
    const includedYs = group.items.filter((it) => !isExcluded(it)).map((it) => it.measurement.fluorescence);
    const groupMean = includedYs.length ? fitMean(includedYs) : null;
    const groupResidual = curve && groupMean !== null ? groupMean - fourPL(group.c, curve.params) : null;

    group.items.forEach((item, index) => {
      const m = item.measurement;
      const excluded = isExcluded(item);
      const row = hwEl("tr");
      row.classList.toggle("is-excluded", excluded);

      if (index === 0) {
        row.classList.add("group-start");
        const rowSpan = group.items.length;
        const groupCell = (text) => Object.assign(hwEl("td", "group-cell", text), { rowSpan });
        row.append(
          groupCell(group.c === 0 ? "Blank (0 nM)" : formatConcentration(group.c)),
          groupCell(String(includedYs.length)),
          groupCell(groupMean === null ? "--" : formatFluorescence(groupMean)),
          groupCell(groupResidual === null ? "--" : formatSignedCounts(groupResidual)),
        );
      }

      const qcCell = hwEl("td");
      if (m.flags.length) qcCell.appendChild(renderFlagChips(m.flags));
      else qcCell.textContent = "--";

      const checkbox = hwEl("input");
      checkbox.type = "checkbox";
      checkbox.checked = excluded;
      checkbox.disabled = locked;
      checkbox.setAttribute("aria-label", `Exclude slot ${item.slot}, ${item.label}`);
      checkbox.addEventListener("change", () => toggleExclusion(m.sample_id, checkbox.checked));

      const reasonCell = hwEl("td");
      if (excluded) {
        const reason = hwEl("input", "table-input");
        reason.type = "text";
        reason.value = fitExclusions.get(m.sample_id);
        reason.placeholder = "Reason (required)";
        reason.disabled = locked;
        reason.dataset.reasonFor = m.sample_id;
        reason.setAttribute("aria-label", `Reason for excluding ${item.label}`);
        reason.classList.toggle("is-missing", !reason.value.trim());
        reason.addEventListener("input", () => {
          fitExclusions.set(m.sample_id, reason.value);
          reason.classList.toggle("is-missing", !reason.value.trim());
          renderFitControls(); // 只更新按鈕，不重畫表格，才不會打字打到一半失去焦點
        });
        reasonCell.appendChild(reason);
      }

      const excludeCell = hwEl("td");
      excludeCell.appendChild(checkbox);

      row.append(
        hwEl("td", null, `#${item.slot} ${item.label}`),
        hwEl("td", null, formatFluorescence(m.fluorescence)),
        hwEl("td", null, curve ? formatSignedCounts(m.fluorescence - fourPL(group.c, curve.params)) : "--"),
        qcCell,
        excludeCell,
        reasonCell,
      );
      tbody.appendChild(row);
    });
  }
}

function renderFitAll() {
  renderFitControls();
  if (!document.getElementById("fit-result-card").hidden) {
    renderFitChart();
    renderFitMetrics();
    renderFitTable();
  }
}

// ---- 動作 ------------------------------------------------------------

function toggleExclusion(sampleId, checked) {
  if (checked) fitExclusions.set(sampleId, fitExclusions.get(sampleId) ?? "");
  else fitExclusions.delete(sampleId);

  if (fitState === "fitted") {
    fitState = "unfitted";
    fitCurveResult = null;
    setHardwareStatus(document.getElementById("fit-status"),
      "Exclusions changed, so the previous fit was discarded. Fit again.", "warn");
  }
  renderFitAll();

  if (checked) {
    const input = [...document.querySelectorAll("[data-reason-for]")].find((el) => el.dataset.reasonFor === sampleId);
    input?.focus();
  }
}

async function runFit() {
  const statusEl = document.getElementById("fit-status");
  fitBusy = true;
  renderFitAll();
  setHardwareStatus(statusEl, "Fitting 4PL...", null);

  try {
    fitCurveResult = await HardwareApi.fitCurve(fitPlan.plan_id, [...fitExclusions.keys()]);
    fitState = "fitted";
    fitHasFittedOnce = true;
    setHardwareStatus(statusEl,
      `Fitted: EC50 ${formatConcentration(fitCurveResult.params.ec50_nM)}, Hill ${fitCurveResult.params.hill.toFixed(2)}, RMSE ${formatFluorescence(fitCurveResult.rmse)} counts.`,
      "success");
  } catch (err) {
    console.error("Fit failed:", err);
    setHardwareStatus(statusEl, `Fit failed: ${err.message}`, "error");
  } finally {
    fitBusy = false;
    renderFitAll();
  }
}

async function saveFit() {
  const statusEl = document.getElementById("save-status");
  fitBusy = true;
  renderFitAll();
  setHardwareStatus(statusEl, "Saving curve...", null);

  try {
    // fitCurve 只收 sample id，理由在存檔時附上。
    const payload = {
      ...fitCurveResult,
      excluded: fitCurveResult.excluded.map((e) => ({
        sample_id: e.sample_id,
        reason: (fitExclusions.get(e.sample_id) ?? "").trim(),
      })),
    };
    fitCurveResult = await HardwareApi.saveCurve(payload);
    fitState = "saved";
    activatePromptOpen = true;
    setHardwareStatus(statusEl, "", null);
    setHardwareStatus(document.getElementById("activate-status"), "", null);
  } catch (err) {
    console.error("Save failed:", err);
    setHardwareStatus(statusEl, `Save failed: ${err.message}`, "error");
  } finally {
    fitBusy = false;
    renderFitAll();
  }
}

async function activateSavedCurve() {
  const statusEl = document.getElementById("activate-status");
  fitBusy = true;
  renderFitControls();
  setHardwareStatus(statusEl, "Setting as active...", null);

  try {
    fitCurveResult = await HardwareApi.saveCurve({ ...fitCurveResult, is_active: true });
    activatePromptOpen = false;
    setHardwareStatus(statusEl, `${fitCurveResult.curve_id} is now the active curve.`, "success");
  } catch (err) {
    console.error("Activation failed:", err);
    setHardwareStatus(statusEl, `Could not set as active: ${err.message}`, "error");
  } finally {
    fitBusy = false;
    renderFitControls();
  }
}

function skipActivation() {
  activatePromptOpen = false;
  const statusEl = document.getElementById("activate-status");
  setHardwareStatus(statusEl, "Left inactive. You can set it as active later on the ", null);
  statusEl.append(hwLink("hardware-curves.html", "Curves page"), ".");
  renderFitControls();
}

function startRefit() {
  fitState = "unfitted";
  fitCurveResult = null;
  activatePromptOpen = false;
  setHardwareStatus(document.getElementById("fit-status"), "", null);
  setHardwareStatus(document.getElementById("activate-status"), "", null);
  renderFitAll();
}

async function initFitPage() {
  const loadEl = document.getElementById("fit-load-status");
  const planId = hardwareQueryParam("plan") ?? hardwareRecall(HARDWARE_LAST_PLAN_KEY);

  if (!planId) {
    setHardwareStatus(loadEl, "No calibration plan selected. ", null);
    loadEl.appendChild(hwLink("hardware-calibration.html", "Create or resume a run →"));
    return;
  }

  try {
    const [loaded, status] = await Promise.all([HardwareApi.getCalibrationPlan(planId), HardwareApi.getDeviceStatus()]);
    fitPlan = loaded;
    fitDeviceFingerprint = status.config.fingerprint;
    if (!hardwareQueryParam("plan")) history.replaceState(null, "", `?plan=${encodeURIComponent(planId)}`);
  } catch (err) {
    console.error("Failed to load plan:", err);
    setHardwareStatus(loadEl, `Could not load plan ${planId}: ${err.message}`, "error");
    return;
  }

  loadEl.hidden = true;
  renderFitSource();
  const complete = fitPlan.items.every((it) => it.measurement);
  document.getElementById("fit-result-card").hidden = !complete;
  document.getElementById("fit-save-card").hidden = !complete;
  renderFitAll();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("fit-button").addEventListener("click", runFit);
  document.getElementById("save-button").addEventListener("click", saveFit);
  document.getElementById("activate-button").addEventListener("click", activateSavedCurve);
  document.getElementById("skip-activate-button").addEventListener("click", skipActivation);
  document.getElementById("refit-button").addEventListener("click", startRefit);
  initFitPage();
});
