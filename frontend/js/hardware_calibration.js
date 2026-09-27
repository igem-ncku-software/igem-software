// =========================================================
// Backs hardware-calibration.html: step 2 of the CAPTURE-Screen workflow. One page walks a
// calibration run through four numbered steps:
//   1 Set up  conditions (biosensor strain, induction time) and either a tube list to read on the
//             instrument, or readings recorded earlier typed in row by row
//   2 Read    the next tube pinned at the top; Read measures it, records it, and moves on
//   3 Fit     4PL, with any tube excluded only with a reason
//   4 Save    the curve, bound to the run's config, signal and conditions
// A step that can't start yet stays visible with what it is waiting for, so the order is always
// on screen. Every state is derived from the stored run plus this page's fit state, never kept
// separately.
//
// Excluded tubes never disappear from the chart or table: they're drawn as hollow grey points and
// kept in the table with their reason.
//
// The saved-run list at the bottom stays visible in every state: it is the only way to reach a
// run other than the last one, and the only place a run restored from a backup shows up.
//
// Backing API: createCalibrationPlan / createManualDataset / fingerprintConfig /
//   getCalibrationPlan / listCalibrationPlans / recordPlanMeasurement / readSample /
//   getDeviceStatus / fitCurve / saveCurve / listCurves
// =========================================================

let plan = null;
let planDeviceFingerprint = null; // null = device unreachable, config can't be confirmed
let planDeviceSensorOk = null;    // DeviceStatus.sensor_ok; null = unreachable or a firmware that doesn't report it
let planCurves = [];              // curves already saved from this run
let rereadSlot = null;            // the slot the user pressed Re-read on; null means measure the "next tube"
let planReading = false;

let fitState = "unfitted";        // unfitted | fitted | saved
let fitCurveResult = null;        // the CalibrationCurve returned by fitCurve / saveCurve
let fitBusy = false;
let fitHasFittedOnce = false;
let fitChart = null;
const fitExclusions = new Map();  // sample_id -> reason; present once ticked, reason may not be filled in yet

function parseConcentrationList(text) {
  return text.split(/[\s,;]+/).filter(Boolean).map(Number);
}

function planComplete(p) {
  return p.items.every((it) => it.measurement);
}

function targetItem() {
  if (rereadSlot !== null) return plan.items.find((it) => it.slot === rereadSlot);
  return plan.items.find((it) => it.measurement === null) ?? null;
}

// Number("") is 0, so an empty cell has to be caught before converting.
function manualNumber(text) {
  const trimmed = String(text).trim();
  return trimmed === "" ? NaN : Number(trimmed);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---- 1. Set up --------------------------------------------------------

function setupSource() {
  return document.querySelector('input[name="setup-source"]:checked').value;
}

function setupConditions() {
  return {
    sensor: document.getElementById("cond-sensor").value.trim(),
    induction_h: manualNumber(document.getElementById("cond-induction").value),
    notes: document.getElementById("cond-notes").value.trim(),
  };
}

function conditionsProblem(c) {
  if (!c.sensor) return "Enter the biosensor strain.";
  if (!(Number.isFinite(c.induction_h) && c.induction_h > 0)) return "Enter the induction time in hours.";
  return null;
}

function updatePlanPreview() {
  const concentrations = parseConcentrationList(document.getElementById("plan-concentrations").value);
  const replicates = Number(document.getElementById("plan-replicates").value);
  const blanks = Number(document.getElementById("plan-blanks").value);
  const preview = document.getElementById("plan-preview");

  const unique = new Set(concentrations);
  if (concentrations.length === 0 || concentrations.some((c) => !(c > 0)) || !(replicates >= 1) || !(blanks >= 0)) {
    preview.textContent = "";
    return;
  }
  preview.textContent = `${unique.size * replicates + blanks} tubes: ${unique.size} concentrations × ${replicates} replicates + ${blanks} blanks`;
}

function updateSetupControls() {
  const source = setupSource();
  document.getElementById("device-fields").hidden = source !== "device";
  document.getElementById("manual-fields").hidden = source !== "manual";
  const button = document.getElementById("setup-create-button");
  button.textContent = source === "device" ? "Create run" : "Create dataset";

  let problem = conditionsProblem(setupConditions());
  if (source === "device") {
    updatePlanPreview();
    // A run is bound to the instrument's config when it is created, so the instrument has to answer.
    if (manualDeviceState === "checking") problem = problem ?? "Checking the instrument...";
    if (manualDeviceState === "offline") problem = problem ?? "The instrument is offline. Connect it, or enter recorded data instead.";
  } else {
    problem = problem ?? updateManualControls();
  }
  setBlocked(button, document.getElementById("setup-create-reason"), problem);
  if (manualCreating) button.disabled = true;
}

async function showSetup(errorText) {
  plan = null;
  document.getElementById("setup-title").textContent = "New calibration run";
  document.getElementById("setup-form-area").hidden = false;
  document.getElementById("setup-summary").hidden = true;
  setStepCard(document.getElementById("setup-card"), "current");
  const waiting = "Create a run first.";
  for (const id of ["read-card", "fit-card", "save-card"]) setStepCard(document.getElementById(id), "waiting", waiting);
  startManualEntry();
  updateSetupControls();
  if (errorText) setHardwareStatus(document.getElementById("setup-status"), errorText, "error");

  // The last run worked on in this browser: offer to resume it, but don't jump there automatically.
  const lastId = hardwareRecall(HARDWARE_LAST_PLAN_KEY);
  if (!lastId) return;
  try {
    const last = await HardwareApi.getCalibrationPlan(lastId);
    const read = last.items.filter((it) => it.measurement).length;
    const resume = document.getElementById("plan-resume");
    resume.textContent = "";
    resume.append(`Last run: ${formatConditions(last.conditions)} · ${read} / ${last.items.length} tubes. `,
      hwLink(`hardware-calibration.html?plan=${encodeURIComponent(last.plan_id)}`, `Open ${last.plan_id} →`));
    resume.hidden = false;
  } catch (err) {
    hardwareRemember(HARDWARE_LAST_PLAN_KEY, null);
  }
}

async function createFromSetup(event) {
  event.preventDefault();
  const button = document.getElementById("setup-create-button");
  const statusEl = document.getElementById("setup-status");
  if (button.disabled) return;

  manualCreating = true;
  updateSetupControls();
  setHardwareStatus(statusEl, "Creating...", null);

  try {
    const conditions = setupConditions();
    // A device run is bound to the instrument's current config, so the device must be reachable
    // (the API layer checks it first). A dataset can carry a config typed in instead.
    const created = setupSource() === "device"
      ? await HardwareApi.createCalibrationPlan({
        concentrations_nM: parseConcentrationList(document.getElementById("plan-concentrations").value),
        replicates: Number(document.getElementById("plan-replicates").value),
        blanks: Number(document.getElementById("plan-blanks").value),
        conditions,
      })
      : await HardwareApi.createManualDataset({
        conditions,
        measured_on: document.getElementById("manual-measured-on").value,
        config: manualConfigMode() === "manual" ? manualConfigValues() : null,
        rows: manualRows.map((row) => ({
          sample_type: row.sample_type,
          concentration_nM: row.sample_type === "standard" ? manualNumber(row.concentration) : null,
          fluorescence: manualNumber(row.signal),
        })),
      });
    // Carry the run id in the URL: a refresh or a shared link both return to the same run.
    history.replaceState(null, "", `?plan=${encodeURIComponent(created.plan_id)}`);
    setHardwareStatus(statusEl, "", null);
    await openPlan(created.plan_id, created);
    refreshHardwareSteps();
  } catch (err) {
    console.error("Run creation failed:", err);
    setHardwareStatus(statusEl, `Could not create: ${err.message}`, "error");
  } finally {
    manualCreating = false;
    if (!plan) updateSetupControls();
  }
}

function renderSetupSummary() {
  document.getElementById("setup-title").textContent = plan.plan_id;
  const manual = plan.source === "manual";
  const tbody = document.getElementById("setup-summary-body");
  tbody.innerHTML = "";
  appendKvRow(tbody, "Biosensor strain", plan.conditions.sensor);
  appendKvRow(tbody, "Induction time", formatHours(plan.conditions.induction_h));
  if (plan.conditions.notes) appendKvRow(tbody, "Notes", plan.conditions.notes);
  appendKvRow(tbody, "Source", manual ? `Recorded data, measured ${plan.measured_on}` : "Read on the instrument");
  appendKvRow(tbody, "Config", hwFingerprint(plan.config_fingerprint));
  appendKvRow(tbody, "Signal", plan.signal);
  appendKvRow(tbody, "Created", formatLocalTime(plan.created_at));

  // Only a run still being read needs the instrument to be on the same config.
  const warning = document.getElementById("plan-config-warning");
  const reading = !manual && !planComplete(plan);
  warning.hidden = !reading || planDeviceFingerprint === plan.config_fingerprint;
  if (!warning.hidden && planDeviceFingerprint === null) {
    setHardwareStatus(warning, "The instrument is unreachable, so its config can't be checked against this run.", "warn");
  } else if (!warning.hidden) {
    setHardwareStatus(warning,
      `The instrument now runs config ${planDeviceFingerprint}, not this run's ${plan.config_fingerprint}. New readings will be flagged STALE_CONFIG and cannot be fitted.`,
      "error");
  }
}

// ---- 2. Read ----------------------------------------------------------

function renderRead() {
  const manual = plan.source === "manual";
  const total = plan.items.length;
  const read = plan.items.filter((it) => it.measurement).length;
  const target = manual ? null : targetItem();

  document.getElementById("next-tube").hidden = manual;
  if (!manual) {
    const banner = document.getElementById("next-tube");
    const label = document.getElementById("next-tube-label");
    const value = document.getElementById("next-tube-value");
    banner.classList.toggle("is-reread", rereadSlot !== null);
    banner.classList.toggle("is-done", !target);
    if (rereadSlot !== null) {
      label.textContent = "Re-read";
      value.textContent = `${target.label} (tube ${target.slot} of ${total})`;
    } else if (target) {
      label.textContent = "Next tube";
      value.textContent = `${target.label} (tube ${target.slot} of ${total})`;
    } else {
      label.textContent = "All tubes read";
      value.textContent = `${total} / ${total} tubes read.`;
    }
    document.getElementById("plan-cancel-reread").hidden = rereadSlot === null;

    const progress = document.getElementById("plan-progress");
    progress.setAttribute("aria-valuemax", String(total));
    progress.setAttribute("aria-valuenow", String(read));
    document.getElementById("plan-progress-fill").style.width = `${(read / total) * 100}%`;
    document.getElementById("plan-progress-text").textContent = `${read} / ${total} read (${formatPercent(read / total)})`;

    const readButton = document.getElementById("plan-read-button");
    readButton.textContent = target ? `Read ${target.label}` : "Read";
    // A dead AS7341 outranks "nothing left to read": neither can be read, but only one is a fault.
    const sensorBlock = sensorReading(planDeviceSensorOk).blocks;
    setBlocked(readButton, document.getElementById("plan-read-reason"),
      sensorBlock || (target ? null : "Every tube has been read. Use Re-read on a row to replace a reading."));
    if (planReading) readButton.disabled = true;
  }

  const tbody = document.getElementById("plan-table-body");
  tbody.innerHTML = "";
  for (const item of plan.items) {
    const m = item.measurement;
    const row = hwEl("tr");
    if (target && item.slot === target.slot) row.classList.add("is-target");

    const statusCell = hwEl("td");
    if (!m) statusCell.appendChild(hwEl("span", "flag-chip", "Pending"));
    else if (manual) statusCell.appendChild(hwEl("span", "flag-chip ok", "Entered"));
    else if (m.flags.length === 0) statusCell.appendChild(hwEl("span", "flag-chip ok", "Read"));
    else statusCell.appendChild(renderFlagChips(m.flags));

    const actionCell = hwEl("td");
    if (m && !manual) {
      const reread = hwEl("button", "btn-secondary table-button", "Re-read");
      reread.type = "button";
      reread.disabled = planReading;
      reread.setAttribute("aria-label", `Re-read slot ${item.slot}, ${item.label}`);
      reread.addEventListener("click", () => {
        rereadSlot = item.slot;
        setHardwareStatus(document.getElementById("plan-read-status"),
          `Put ${item.label} back in the reader, then press Read.`, null);
        renderAll();
        document.getElementById("plan-read-button").focus();
      });
      actionCell.appendChild(reread);
    }

    row.append(
      hwEl("td", null, String(item.slot)),
      hwEl("td", null, item.label),
      statusCell,
      hwEl("td", null, m ? formatFluorescence(m.fluorescence) : "--"),
      hwEl("td", null, m ? (manual ? m.timestamp_utc : formatLocalTime(m.timestamp_utc)) : "--"),
      actionCell,
    );
    tbody.appendChild(row);
  }
}

async function readPlanTarget() {
  const item = targetItem();
  if (!item || planReading) return;

  const statusEl = document.getElementById("plan-read-status");
  planReading = true;
  renderAll();
  setHardwareStatus(statusEl, `Reading tube ${item.slot} (${item.label})...`, null);

  try {
    const input = {
      sample_id: `${plan.plan_id}-${String(item.slot).padStart(2, "0")}`,
      sample_type: item.sample_type,
    };
    if (item.sample_type === "standard") input.known_concentration_nM = item.concentration_nM;

    const [m, status] = await Promise.all([HardwareApi.readSample(input), HardwareApi.getDeviceStatus()]);
    planDeviceFingerprint = status.config.fingerprint;
    planDeviceSensorOk = status.sensor_ok;
    plan = await HardwareApi.recordPlanMeasurement(plan.plan_id, item.slot, m);
    rereadSlot = null;
    // The data under any fit just changed, so the fit no longer describes it.
    if (fitState !== "unfitted") discardFit();

    const recorded = plan.items.find((it) => it.slot === item.slot).measurement;
    const flagText = recorded.flags.length ? ` Flags: ${recorded.flags.join(", ")}.` : "";
    setHardwareStatus(statusEl,
      `Recorded tube ${item.slot} (${item.label}): ${formatFluorescence(recorded.fluorescence)} ${HARDWARE_FLUORESCENCE_UNIT}.${flagText}`,
      recorded.flags.length ? "warn" : "success");
  } catch (err) {
    console.error("Run reading failed:", err);
    setHardwareStatus(statusEl, `Read failed for tube ${item.slot}: ${err.message}`, "error");
  } finally {
    planReading = false;
    renderAll();
    // Keeps the run list's progress column from contradicting the run card right above it.
    refreshRuns();
    if (planComplete(plan)) refreshHardwareSteps();
    document.getElementById("plan-read-button").focus();
  }
}

// ---- 3. Fit -------------------------------------------------------------

// Error bars. Chart.js has no built-in support and a plugin would be a new dependency, so this draws them manually:
// reads errorBars: true on the dataset, and each point's sd sets the bar's length above and below.
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

// Groups by concentration (blank counts as 0), sorted by slot within each group.
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

// Only fitted / saved states have a curve that can be drawn or used to compute residuals.
function currentCurve() {
  return fitState === "unfitted" ? null : fitCurveResult;
}

function discardFit() {
  fitState = "unfitted";
  fitCurveResult = null;
}

function blockedFitReason() {
  if (fitState === "fitted") return "Already fitted with these exclusions. Change an exclusion to fit again.";
  if (fitState === "saved") return "This fit is saved. Use “Fit again with different exclusions” below to start a new one.";
  const missing = missingReasonCount();
  if (missing > 0) return `Give a reason for every excluded tube (${missing} missing).`;
  return null;
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
  const standards = plan.items.filter((it) => it.sample_type === "standard");
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
    { label: "Tube (included)", data: included, pointRadius: 3, pointBackgroundColor: accent, pointBorderColor: accent, showLine: false },
    {
      label: "Tube (excluded)", data: excluded, pointRadius: 4.5, pointBackgroundColor: "rgba(0,0,0,0)",
      pointBorderColor: muted, pointBorderWidth: 1.5, showLine: false,
    },
    {
      label: "Mean ± SD", data: means, pointStyle: "rect", pointRadius: 5, pointBackgroundColor: ink,
      pointBorderColor: ink, borderColor: ink, showLine: false, errorBars: true,
    },
  ];

  if (curve) {
    // The curve is only drawn within the standards' concentration range: drawing beyond it would be extrapolating on the chart.
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
      { label: "4PL fit", data: curvePoints, type: "line", pointRadius: 0, borderWidth: 2, tension: 0, borderColor: gold },
      {
        label: "EC50",
        data: [{ x: curve.params.ec50_nM, y: Math.min(...allY) }, { x: curve.params.ec50_nM, y: Math.max(...allY) }],
        type: "line", pointRadius: 0, borderWidth: 1.5, borderDash: [6, 4], borderColor: error,
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
          title: { display: true, text: `sfGFP signal · ${plan.signal} (${HARDWARE_FLUORESCENCE_UNIT})`, color: ink },
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
  set("fit-hill-sub", `Top ${formatFluorescence(curve.params.top)} · bottom ${formatFluorescence(curve.params.bottom)} ${HARDWARE_FLUORESCENCE_UNIT}`);
  set("fit-lod", formatConcentration(curve.lod_nM));
  set("fit-lod-sub", `LOQ ${formatConcentration(curve.loq_nM)}`);
  set("fit-rmse", formatFluorescence(curve.rmse));
  set("fit-rmse-sub", HARDWARE_FLUORESCENCE_UNIT);
}

function renderFitTable() {
  const tbody = document.getElementById("fit-table-body");
  tbody.innerHTML = "";
  const curve = currentCurve();
  const locked = fitBusy || fitState === "saved";

  for (const group of groupPlanItems(plan.items)) {
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
          groupCell(groupResidual === null ? "--" : formatSignedFluorescence(groupResidual)),
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
          renderFitControls(); // only the buttons, not the table, so typing mid-word doesn't lose focus
        });
        reasonCell.appendChild(reason);
      }

      const excludeCell = hwEl("td");
      excludeCell.appendChild(checkbox);

      row.append(
        hwEl("td", null, `#${item.slot} ${item.label}`),
        hwEl("td", null, formatFluorescence(m.fluorescence)),
        hwEl("td", null, curve ? formatSignedFluorescence(m.fluorescence - fourPL(group.c, curve.params)) : "--"),
        qcCell,
        excludeCell,
        reasonCell,
      );
      tbody.appendChild(row);
    });
  }
}

function toggleExclusion(sampleId, checked) {
  if (checked) fitExclusions.set(sampleId, fitExclusions.get(sampleId) ?? "");
  else fitExclusions.delete(sampleId);

  if (fitState === "fitted") {
    discardFit();
    setHardwareStatus(document.getElementById("fit-status"), "Exclusions changed, so the previous fit was discarded. Fit again.", "warn");
  }
  renderAll();

  if (checked) {
    const input = [...document.querySelectorAll("[data-reason-for]")].find((el) => el.dataset.reasonFor === sampleId);
    input?.focus();
  }
}

async function runFit() {
  const statusEl = document.getElementById("fit-status");
  fitBusy = true;
  renderAll();
  setHardwareStatus(statusEl, "Fitting 4PL...", null);

  try {
    fitCurveResult = await HardwareApi.fitCurve(plan.plan_id, [...fitExclusions.keys()]);
    fitState = "fitted";
    fitHasFittedOnce = true;
    setHardwareStatus(statusEl,
      `Fitted: EC50 ${formatConcentration(fitCurveResult.params.ec50_nM)}, Hill ${fitCurveResult.params.hill.toFixed(2)}, RMSE ${formatFluorescence(fitCurveResult.rmse)} ${HARDWARE_FLUORESCENCE_UNIT}.`,
      "success");
  } catch (err) {
    console.error("Fit failed:", err);
    setHardwareStatus(statusEl, `Fit failed: ${err.message}`, "error");
  } finally {
    fitBusy = false;
    renderAll();
  }
}

// ---- 4. Save ---------------------------------------------------------

function blockedSaveReason() {
  if (fitState === "unfitted") {
    return fitHasFittedOnce ? "Exclusions changed since the last fit. Fit again before saving." : "Fit the curve first.";
  }
  const missing = missingReasonCount();
  if (missing > 0) return `Give a reason for every excluded tube (${missing} missing).`;
  return null;
}

function renderFitControls() {
  const fitButton = document.getElementById("fit-button");
  setBlocked(fitButton, document.getElementById("fit-reason"), blockedFitReason());
  if (fitBusy) fitButton.disabled = true;

  const saveButton = document.getElementById("save-button");
  saveButton.hidden = fitState !== "fitted";
  setBlocked(saveButton, document.getElementById("save-reason"), fitState === "fitted" ? blockedSaveReason() : null);
  if (fitBusy) saveButton.disabled = true;

  const binding = document.getElementById("save-binding");
  binding.hidden = fitState !== "fitted";
  binding.textContent = "";
  binding.append("Bound to config ", hwFingerprint(plan.config_fingerprint),
    `, signal ${plan.signal}, and ${formatConditions(plan.conditions)}.`);

  const refit = document.getElementById("refit-button");
  refit.hidden = fitState !== "saved";
  refit.disabled = fitBusy;
}

function renderSavedCurves() {
  const wrapper = document.getElementById("saved-curves");
  const list = document.getElementById("saved-curves-list");
  wrapper.hidden = planCurves.length === 0;
  list.innerHTML = "";
  for (const curve of planCurves) {
    const li = hwEl("li", "choice is-static");
    const text = hwEl("div");
    text.append(
      hwEl("span", "choice-title", curve.curve_id),
      hwEl("span", "choice-meta",
        `EC50 ${formatConcentration(curve.params.ec50_nM)} · LOD ${formatConcentration(curve.lod_nM)} · `
        + `range ${formatConcentrationInterval([curve.range_nM.min, curve.range_nM.max])} · `
        + `${plural(curve.excluded.length, "tube")} excluded · fitted ${formatLocalTime(curve.fitted_at)}`),
    );
    const links = hwEl("span", "choice-meta");
    links.append(hwLink(`hardware-measure.html?curve=${encodeURIComponent(curve.curve_id)}`, "Measure with this curve →"));
    text.appendChild(links);
    li.appendChild(text);
    list.appendChild(li);
  }
}

async function saveFit() {
  const statusEl = document.getElementById("save-status");
  fitBusy = true;
  renderAll();
  setHardwareStatus(statusEl, "Saving curve...", null);

  try {
    // fitCurve only takes sample ids; the reason is attached when saving.
    const payload = {
      ...fitCurveResult,
      excluded: fitCurveResult.excluded.map((e) => ({ sample_id: e.sample_id, reason: (fitExclusions.get(e.sample_id) ?? "").trim() })),
    };
    fitCurveResult = await HardwareApi.saveCurve(payload);
    fitState = "saved";
    planCurves = [fitCurveResult, ...planCurves];
    setHardwareStatus(statusEl, `Saved as ${fitCurveResult.curve_id}.`, "success");
    refreshRuns();
    refreshHardwareSteps();
  } catch (err) {
    console.error("Save failed:", err);
    setHardwareStatus(statusEl, `Save failed: ${err.message}`, "error");
  } finally {
    fitBusy = false;
    renderAll();
  }
}

function startRefit() {
  discardFit();
  setHardwareStatus(document.getElementById("fit-status"), "", null);
  setHardwareStatus(document.getElementById("save-status"), "", null);
  renderAll();
  document.getElementById("fit-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- The open run -----------------------------------------------------------

function renderAll() {
  if (!plan) return;
  const complete = planComplete(plan);
  const pending = plan.items.filter((it) => !it.measurement).length;

  renderSetupSummary();
  setStepCard(document.getElementById("setup-card"), "done");

  setStepCard(document.getElementById("read-card"), complete ? "done" : "current");
  renderRead();

  const fitCard = document.getElementById("fit-card");
  if (!complete) {
    setStepCard(fitCard, "waiting", `${pending} of ${plan.items.length} tubes are still unread.`);
  } else {
    setStepCard(fitCard, fitState !== "unfitted" || planCurves.length > 0 ? "done" : "current");
    renderFitChart();
    renderFitMetrics();
    renderFitTable();
  }

  const saveCard = document.getElementById("save-card");
  if (fitState === "fitted") setStepCard(saveCard, "current");
  else if (fitState === "saved" || planCurves.length > 0) setStepCard(saveCard, "done");
  else setStepCard(saveCard, "waiting", complete ? "Fit the curve first." : "Read every tube, then fit.");
  renderFitControls();
  renderSavedCurves();
}

async function openPlan(planId, alreadyLoaded) {
  stopManualEntry();
  // The run lives in the browser: it still opens when the device is unreachable, just without a config check.
  const [planResult, statusResult, curvesResult] = await Promise.allSettled([
    alreadyLoaded ? Promise.resolve(alreadyLoaded) : HardwareApi.getCalibrationPlan(planId),
    HardwareApi.getDeviceStatus(),
    HardwareApi.listCurves(),
  ]);

  if (planResult.status === "rejected") {
    console.error("Failed to load run:", planResult.reason);
    history.replaceState(null, "", "hardware-calibration.html");
    showSetup(`Could not load run ${planId}: ${planResult.reason.message}`);
    return;
  }
  plan = planResult.value;
  planDeviceFingerprint = statusResult.status === "fulfilled" ? statusResult.value.config.fingerprint : null;
  planDeviceSensorOk = statusResult.status === "fulfilled" ? statusResult.value.sensor_ok : null;
  planCurves = curvesResult.status === "fulfilled" ? curvesResult.value.filter((curve) => curve.plan_id === plan.plan_id) : [];
  hardwareRemember(HARDWARE_LAST_PLAN_KEY, plan.plan_id);

  document.getElementById("setup-form-area").hidden = true;
  document.getElementById("setup-summary").hidden = false;
  renderAll();
  refreshRuns();
  if (plan.source === "device" && !planComplete(plan)) {
    if (statusResult.status === "rejected") {
      setHardwareStatus(document.getElementById("plan-read-status"), `Read unavailable: ${statusResult.reason.message}`, "error");
    }
    document.getElementById("plan-read-button").focus();
  }
}

// ---- Set up: readings recorded earlier, entered by hand ------------------

// Two blanks and four standards, the fewest a dataset can hold. Only the types are set, never values.
const MANUAL_START_ROWS = ["blank", "blank", "standard", "standard", "standard", "standard"];

const manualRows = []; // { sample_type, concentration, signal }, the last two as typed
let manualDeviceState = "checking"; // checking | online | offline; also gates creating an instrument run
let manualDeviceFingerprint = null;
let manualPollTimer = null;
let manualCreating = false;

function manualToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function manualConfigMode() {
  return document.querySelector('input[name="manual-config-mode"]:checked').value;
}

function manualConfigValues() {
  const value = (id) => document.getElementById(id).value.trim();
  return {
    led_current_mA: manualNumber(value("manual-led")),
    gain: manualNumber(value("manual-gain")),
    atime: manualNumber(value("manual-atime")),
    astep: manualNumber(value("manual-astep")),
    build_id: value("manual-build"),
  };
}

// { fingerprint } when the config is known, otherwise { error } saying why not.
function manualConfig() {
  if (manualConfigMode() === "current") {
    if (manualDeviceState === "checking") return { error: "Checking the instrument's config..." };
    if (manualDeviceState === "offline") {
      return { error: "Instrument unreachable, so its current config is unknown. Enter the config manually." };
    }
    return { fingerprint: manualDeviceFingerprint };
  }
  try {
    return { fingerprint: HardwareApi.fingerprintConfig(manualConfigValues()) };
  } catch (err) {
    return { error: err.message };
  }
}

function manualCellProblem(row, field) {
  const text = row[field].trim();
  const value = manualNumber(text);
  if (field === "concentration") {
    if (row.sample_type !== "standard") return null;
    if (!text) return "enter the concentration.";
    return Number.isFinite(value) && value > 0 ? null : "concentration must be a positive number.";
  }
  if (!text) return "enter the signal.";
  return Number.isFinite(value) && value >= 0 ? null : "signal must be a number ≥ 0.";
}

function manualCounts() {
  const concentrations = new Set(manualRows
    .filter((row) => row.sample_type === "standard" && !manualCellProblem(row, "concentration"))
    .map((row) => manualNumber(row.concentration)));
  return {
    tubes: manualRows.length,
    concentrations: concentrations.size,
    blanks: manualRows.filter((row) => row.sample_type === "blank").length,
  };
}

function manualProblem(config) {
  const measuredOn = document.getElementById("manual-measured-on").value;
  if (!measuredOn) return "Enter the date the readings were taken.";
  if (measuredOn > manualToday()) return "The measurement date is in the future.";
  if (config.error) return config.error;
  for (const [i, row] of manualRows.entries()) {
    const problem = manualCellProblem(row, "concentration") ?? manualCellProblem(row, "signal");
    if (problem) return `Row ${i + 1}: ${problem}`;
  }
  const { concentrations, blanks } = manualCounts();
  if (concentrations < 4) return "A 4PL fit needs at least 4 distinct concentrations.";
  if (blanks < 2) return "Enter at least 2 blanks: LOD needs a blank SD.";
  return null;
}

// Refreshes the manual-entry summary lines and returns what blocks creating the dataset, or null.
function updateManualControls() {
  const config = manualConfig();
  const { tubes, concentrations, blanks } = manualCounts();
  document.getElementById("manual-summary").textContent =
    `${plural(tubes, "tube")}: ${plural(concentrations, "concentration")}, ${plural(blanks, "blank")}`;

  const fingerprintEl = document.getElementById("manual-fingerprint");
  fingerprintEl.textContent = "";
  if (config.fingerprint) {
    fingerprintEl.append("Config fingerprint ", hwFingerprint(config.fingerprint));
    if (manualConfigMode() === "manual" && manualDeviceFingerprint) {
      if (config.fingerprint === manualDeviceFingerprint) {
        fingerprintEl.append(" · matches the instrument now");
      } else {
        fingerprintEl.append(" · the instrument now runs ", hwFingerprint(manualDeviceFingerprint),
          ", so a curve from this dataset can't measure until they match");
      }
    }
  }
  return manualProblem(config);
}

async function refreshManualDevice() {
  try {
    manualDeviceFingerprint = (await HardwareApi.getDeviceStatus()).config.fingerprint;
    manualDeviceState = "online";
  } catch (err) {
    manualDeviceFingerprint = null;
    manualDeviceState = "offline";
  }
  updateSetupControls();
}

function focusManualSignal(index) {
  document.querySelector(`[data-manual-signal="${index}"]`)?.focus();
}

// A new row copies the previous row's type and concentration, since replicates are entered one
// after another; its signal always starts empty.
function addManualRow() {
  const last = manualRows[manualRows.length - 1];
  manualRows.push({ sample_type: last?.sample_type ?? "standard", concentration: last?.concentration ?? "", signal: "" });
  renderManualRows();
  updateSetupControls();
  focusManualSignal(manualRows.length - 1);
}

function manualInput(row, field, index, label) {
  const input = hwEl("input", "table-input");
  input.type = "text";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.value = row[field];
  input.setAttribute("aria-label", label);

  const mark = () => {
    const invalid = row[field].trim() !== "" && manualCellProblem(row, field) !== null;
    input.classList.toggle("is-missing", invalid);
    input.setAttribute("aria-invalid", String(invalid));
  };
  mark();
  input.addEventListener("input", () => {
    row[field] = input.value;
    mark();
  });
  // Enter moves down a row instead of submitting the form.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (index === manualRows.length - 1) addManualRow();
    else focusManualSignal(index + 1);
  });
  return { input, mark };
}

function renderManualRows() {
  const tbody = document.getElementById("manual-table-body");
  tbody.innerHTML = "";

  manualRows.forEach((row, i) => {
    const n = i + 1;
    const cell = (child, className) => {
      const td = hwEl("td", className);
      td.appendChild(child);
      return td;
    };

    const concentration = manualInput(row, "concentration", i, `Row ${n} concentration (nM)`);
    const signal = manualInput(row, "signal", i, `Row ${n} sfGFP signal (basic counts)`);
    signal.input.dataset.manualSignal = String(i);
    const setType = () => {
      const blank = row.sample_type === "blank";
      concentration.input.disabled = blank;
      concentration.input.placeholder = blank ? "0" : "";
      concentration.mark();
    };

    const type = hwEl("select", "table-input");
    for (const [value, text] of [["blank", "Blank"], ["standard", "Standard"]]) {
      const option = hwEl("option", null, text);
      option.value = value;
      type.appendChild(option);
    }
    type.value = row.sample_type;
    type.setAttribute("aria-label", `Row ${n} type`);
    type.addEventListener("change", () => {
      row.sample_type = type.value;
      row.concentration = "";
      concentration.input.value = "";
      setType();
    });
    setType();

    const remove = hwEl("button", "btn-secondary table-button", "Remove");
    remove.type = "button";
    remove.disabled = manualRows.length === 1;
    remove.setAttribute("aria-label", `Remove row ${n}`);
    remove.addEventListener("click", () => {
      manualRows.splice(i, 1);
      renderManualRows();
      updateSetupControls();
    });

    const tr = hwEl("tr");
    tr.append(hwEl("td", null, String(n)), cell(type), cell(concentration.input), cell(signal.input), cell(remove, "action-cell"));
    tbody.appendChild(tr);
  });
}

function startManualEntry() {
  if (manualPollTimer !== null) return;
  if (manualRows.length === 0) {
    for (const type of MANUAL_START_ROWS) manualRows.push({ sample_type: type, concentration: "", signal: "" });
  }
  document.getElementById("manual-measured-on").max = manualToday();
  renderManualRows();
  refreshManualDevice();
  manualPollTimer = setInterval(refreshManualDevice, DEVICE_STATUS_POLL_INTERVAL_MS);
}

function stopManualEntry() {
  clearInterval(manualPollTimer);
  manualPollTimer = null;
}

// ---- Saved runs: the list and a CSV per run ------------------
// A run holds the readings a curve was fitted from, and until the backend stores anything they
// exist only in this browser. The CSV here is for reading and analysing one run; the backup that
// protects them all is on the Data page.

const RUNS_CSV_HEADERS = [
  "plan_id", "plan_source", "sensor", "induction_h", "notes", "plan_config_fingerprint", "plan_signal", "plan_measured_on",
  "slot", "label", "sample_type", "concentration_nM",
  "sample_id", "timestamp_utc", "signal", "fluorescence", "fluorescence_sd", "scatter",
  "flags", "config_fingerprint", "source",
  ...HARDWARE_CHANNELS.map(({ key }) => key),
];

// One row per tube, read or not: an unread slot is part of what happened to the run.
function runCsvRows(p) {
  return p.items.map((item) => {
    const m = item.measurement;
    const raw = m?.raw ?? {};
    return [
      p.plan_id, p.source, p.conditions.sensor, p.conditions.induction_h, p.conditions.notes,
      p.config_fingerprint, p.signal, p.measured_on,
      item.slot, item.label, item.sample_type, item.concentration_nM,
      m?.sample_id ?? null, m?.timestamp_utc ?? null, m?.signal ?? null, m?.fluorescence ?? null,
      m?.fluorescence_sd ?? null, m?.scatter ?? null,
      m ? m.flags.join(";") : null, m?.config_fingerprint ?? null, m?.source ?? null,
      ...HARDWARE_CHANNELS.map(({ key }) => raw[key] ?? null),
    ];
  });
}

function renderRuns(runs) {
  document.getElementById("runs-empty").hidden = runs.length > 0;
  document.getElementById("runs-table-wrapper").hidden = runs.length === 0;
  const tbody = document.getElementById("runs-table-body");
  tbody.innerHTML = "";

  for (const summary of runs) {
    const csv = hwEl("button", "btn-secondary table-button", "CSV");
    csv.type = "button";
    csv.setAttribute("aria-label", `Export run ${summary.plan_id} as CSV`);
    csv.addEventListener("click", () => exportRunCsv(summary.plan_id, csv));

    const actions = hwEl("td", "action-cell");
    actions.append(hwLink(`hardware-calibration.html?plan=${encodeURIComponent(summary.plan_id)}`, "Open"), " ", csv);

    const config = hwEl("td");
    config.appendChild(hwFingerprint(summary.config_fingerprint));

    const row = hwEl("tr");
    if (plan && plan.plan_id === summary.plan_id) row.classList.add("is-target");
    row.append(
      hwEl("td", null, summary.plan_id),
      hwEl("td", null, formatLocalTime(summary.created_at)),
      hwEl("td", null, formatConditions(summary.conditions)),
      hwEl("td", null, summary.source === "manual" ? "Recorded data" : "Instrument"),
      config,
      hwEl("td", null, `${summary.read} / ${summary.total}`),
      hwEl("td", null, String(summary.curve_ids.length)),
      actions,
    );
    tbody.appendChild(row);
  }
}

async function refreshRuns() {
  const statusEl = document.getElementById("runs-status");
  try {
    renderRuns(await HardwareApi.listCalibrationPlans());
    setHardwareStatus(statusEl, "", null);
  } catch (err) {
    console.error("Could not load saved runs:", err);
    setHardwareStatus(statusEl, `Could not load saved runs: ${err.message}`, "error");
  }
}

async function exportRunCsv(plan_id, button) {
  const statusEl = document.getElementById("runs-export-status");
  button.disabled = true;
  try {
    const exported = await HardwareApi.getCalibrationPlan(plan_id);
    hwDownloadCsv(`lasreader-${plan_id}-${hwFileStamp()}.csv`, RUNS_CSV_HEADERS, runCsvRows(exported));
    setHardwareStatus(statusEl, `Exported ${plan_id}: ${exported.items.length} tubes.`, "success");
  } catch (err) {
    console.error("Run CSV export failed:", err);
    setHardwareStatus(statusEl, `Export failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("setup-form");
  form.addEventListener("submit", createFromSetup);
  form.addEventListener("input", updateSetupControls);
  form.addEventListener("change", (event) => {
    if (event.target.name === "manual-config-mode") {
      document.getElementById("manual-config-fields").hidden = manualConfigMode() !== "manual";
    }
    updateSetupControls();
  });
  document.getElementById("manual-add-row").addEventListener("click", addManualRow);

  document.getElementById("plan-read-button").addEventListener("click", readPlanTarget);
  document.getElementById("plan-cancel-reread").addEventListener("click", () => {
    rereadSlot = null;
    setHardwareStatus(document.getElementById("plan-read-status"), "", null);
    renderAll();
  });
  document.getElementById("fit-button").addEventListener("click", runFit);
  document.getElementById("save-button").addEventListener("click", saveFit);
  document.getElementById("refit-button").addEventListener("click", startRefit);

  refreshRuns();

  const planId = hardwareQueryParam("plan");
  if (planId) openPlan(planId);
  else showSetup();
});
