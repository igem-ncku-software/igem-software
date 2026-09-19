// =========================================================
// Backs hardware-calibration.html: creates a calibration plan and measures each tube in slot
// order, or takes readings recorded earlier as a manual dataset.
//
// State machine (derived from the plan data, not stored separately):
//   no_plan      -> shows only the create form and the recorded-data form (no ?plan= in the URL)
//   plan_created -> list, progress 0/N, Read enabled
//   running      -> progress n/N, Read enabled, Go to fit disabled
//   complete     -> everything measured, Go to fit enabled
//
// The instrument has only one cuvette, so "what's the next tube" is pinned in a sticky
// block at the top of the page; pressing Read measures the "next tube", records it
// automatically, and advances to the next one. An already-measured tube can be redone with Re-read.
//
// A manual dataset has every slot filled at creation and can't be re-read, so it never shows
// here: creating one, or opening one by ?plan=, goes straight to the fit page.
//
// Target elements: #plan-create-card / #plan-form / #plan-* family, #manual-* family,
//   #runs-* family (the saved-run list and its per-run CSV), see the HTML
// Backing API: createCalibrationPlan / getCalibrationPlan / recordPlanMeasurement /
//   readSample / getDeviceStatus / createManualDataset / fingerprintConfig /
//   listCalibrationPlans
//
// The saved-run list at the bottom stays visible in every state: it is the only way to reach a run
// other than the last one, and the only place a run restored from a backup shows up. Backing runs
// up is the Status page's job, in one file with the curves and readings.
// =========================================================

let plan = null;
let planDeviceFingerprint = null; // null = device unreachable, config can't be confirmed
let planDeviceSensorOk = null;    // DeviceStatus.sensor_ok; null = unreachable or a firmware that doesn't report it
let rereadSlot = null; // the slot the user pressed Re-read on; null means measure the "next tube"
let planReading = false;

const PLAN_STATE_CHIP = {
  plan_created: ["Plan created", ""],
  running: ["Running", "warn"],
  complete: ["Complete", "ok"],
};

function parseConcentrationList(text) {
  return text.split(/[\s,;]+/).filter(Boolean).map(Number);
}

function planState(p) {
  if (!p) return "no_plan";
  const read = p.items.filter((it) => it.measurement).length;
  if (read === 0) return "plan_created";
  return read < p.items.length ? "running" : "complete";
}

function targetItem() {
  if (rereadSlot !== null) return plan.items.find((it) => it.slot === rereadSlot);
  return plan.items.find((it) => it.measurement === null) ?? null;
}

// ---- no_plan ---------------------------------------------------------

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
  const total = unique.size * replicates + blanks;
  preview.textContent = `${total} tubes: ${unique.size} concentrations × ${replicates} replicates + ${blanks} blanks`;
}

async function showCreateForm(errorText) {
  plan = null;
  document.getElementById("plan-run-card").hidden = true;
  document.getElementById("plan-create-card").hidden = false;
  document.getElementById("manual-card").hidden = false;
  updatePlanPreview();
  startManualEntry();
  if (errorText) setHardwareStatus(document.getElementById("plan-create-status"), errorText, "error");

  // The last plan worked on in this browser: offer a link to resume it, but don't jump there automatically.
  const lastId = hardwareRecall(HARDWARE_LAST_PLAN_KEY);
  if (!lastId) return;
  try {
    const last = await HardwareApi.getCalibrationPlan(lastId);
    const read = last.items.filter((it) => it.measurement).length;
    const resume = document.getElementById("plan-resume");
    resume.textContent = "";
    if (last.source === "manual") {
      resume.append(`Last dataset in this browser: ${last.items.length} tubes entered. `,
        hwLink(`hardware-calibration-fit.html?plan=${encodeURIComponent(last.plan_id)}`, `Open ${last.plan_id} in Fit →`));
    } else {
      resume.append(`Last run in this browser: ${read} / ${last.items.length} tubes read. `,
        hwLink(`hardware-calibration.html?plan=${encodeURIComponent(last.plan_id)}`, `Resume ${last.plan_id} →`));
    }
    resume.hidden = false;
  } catch (err) {
    hardwareRemember(HARDWARE_LAST_PLAN_KEY, null);
  }
}

async function createPlan(event) {
  event.preventDefault();
  const button = document.getElementById("plan-create-button");
  const statusEl = document.getElementById("plan-create-status");

  button.disabled = true;
  setHardwareStatus(statusEl, "Creating plan...", null);

  try {
    // The plan is bound to the device's current config, so the device must be reachable to create one (the API layer checks the device first).
    const created = await HardwareApi.createCalibrationPlan({
      concentrations_nM: parseConcentrationList(document.getElementById("plan-concentrations").value),
      replicates: Number(document.getElementById("plan-replicates").value),
      blanks: Number(document.getElementById("plan-blanks").value),
      timepoint: document.getElementById("plan-timepoint").value,
    });
    // Carry the plan id in the URL: a refresh or a shared link both return to the same run.
    history.replaceState(null, "", `?plan=${encodeURIComponent(created.plan_id)}`);
    setHardwareStatus(statusEl, "", null);
    await openPlan(created.plan_id, created);
  } catch (err) {
    console.error("Plan creation failed:", err);
    setHardwareStatus(statusEl, `Could not create plan: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

// ---- plan_created / running / complete ---------------------------------

async function openPlan(planId, alreadyLoaded) {
  document.getElementById("plan-create-card").hidden = true;
  document.getElementById("manual-card").hidden = true;
  stopManualEntry();
  const runCard = document.getElementById("plan-run-card");

  // The plan lives in the browser: it still opens when the device is unreachable, just without a config check.
  const [planResult, statusResult] = await Promise.allSettled([
    alreadyLoaded ? Promise.resolve(alreadyLoaded) : HardwareApi.getCalibrationPlan(planId),
    HardwareApi.getDeviceStatus(),
  ]);

  if (planResult.status === "rejected") {
    console.error("Failed to load plan:", planResult.reason);
    showCreateForm(`Could not load plan ${planId}: ${planResult.reason.message}`);
    return;
  }

  if (planResult.value.source === "manual") {
    window.location.replace(`hardware-calibration-fit.html?plan=${encodeURIComponent(planId)}`);
    return;
  }
  plan = planResult.value;
  planDeviceFingerprint = statusResult.status === "fulfilled" ? statusResult.value.config.fingerprint : null;
  planDeviceSensorOk = statusResult.status === "fulfilled" ? statusResult.value.sensor_ok : null;
  hardwareRemember(HARDWARE_LAST_PLAN_KEY, plan.plan_id);
  runCard.hidden = false;
  renderPlan();
  refreshRuns();
  if (statusResult.status === "rejected") {
    setHardwareStatus(document.getElementById("plan-read-status"), `Read unavailable: ${statusResult.reason.message}`, "error");
  }
  document.getElementById("plan-read-button").focus();
}

function renderPlan() {
  const total = plan.items.length;
  const read = plan.items.filter((it) => it.measurement).length;
  const state = planState(plan);
  const target = targetItem();

  document.getElementById("plan-title").textContent = plan.plan_id;

  const [stateText, stateKind] = PLAN_STATE_CHIP[state];
  const chip = document.getElementById("plan-state");
  chip.textContent = stateText;
  chip.className = `flag-chip ${stateKind}`.trim();

  const meta = document.getElementById("plan-meta");
  meta.textContent = "";
  meta.append(`Timepoint ${plan.timepoint} · created ${formatLocalTime(plan.created_at)} · bound to config `,
    hwFingerprint(plan.config_fingerprint));

  const configWarning = document.getElementById("plan-config-warning");
  configWarning.hidden = planDeviceFingerprint === plan.config_fingerprint;
  if (planDeviceFingerprint === null) {
    setHardwareStatus(configWarning,
      "The instrument is unreachable, so its config can't be checked against this plan.", "warn");
  } else if (!configWarning.hidden) {
    setHardwareStatus(configWarning,
      `The instrument now runs config ${planDeviceFingerprint}, not this plan's ${plan.config_fingerprint}. New readings will be flagged STALE_CONFIG and cannot be fitted.`,
      "error");
  }

  // Next-tube prompt
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
    value.textContent = `${total} / ${total} tubes read. Ready to fit.`;
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

  const fitButton = document.getElementById("plan-fit-button");
  fitButton.classList.toggle("btn-secondary", state !== "complete");
  setBlocked(fitButton, document.getElementById("plan-fit-reason"),
    state === "complete" ? null : `${total - read} of ${total} tubes are still unread. Every tube must be read before fitting.`);

  renderPlanTable(target);
}

function renderPlanTable(target) {
  const tbody = document.getElementById("plan-table-body");
  tbody.innerHTML = "";

  for (const item of plan.items) {
    const m = item.measurement;
    const row = hwEl("tr");
    if (target && item.slot === target.slot) row.classList.add("is-target");

    const statusCell = hwEl("td");
    if (!m) statusCell.appendChild(hwEl("span", "flag-chip", "Pending"));
    else if (m.flags.length === 0) statusCell.appendChild(hwEl("span", "flag-chip ok", "Read"));
    else statusCell.appendChild(renderFlagChips(m.flags));

    const actionCell = hwEl("td");
    if (m) {
      const reread = hwEl("button", "btn-secondary table-button", "Re-read");
      reread.type = "button";
      reread.disabled = planReading;
      reread.setAttribute("aria-label", `Re-read slot ${item.slot}, ${item.label}`);
      reread.addEventListener("click", () => {
        rereadSlot = item.slot;
        setHardwareStatus(document.getElementById("plan-read-status"),
          `Put ${item.label} back in the reader, then press Read.`, null);
        renderPlan();
        document.getElementById("plan-read-button").focus();
      });
      actionCell.appendChild(reread);
    }

    row.append(
      hwEl("td", null, String(item.slot)),
      hwEl("td", null, item.label),
      statusCell,
      hwEl("td", null, m ? formatFluorescence(m.fluorescence) : "--"),
      hwEl("td", null, m ? formatLocalTime(m.timestamp_utc) : "--"),
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
  renderPlan();
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

    const recorded = plan.items.find((it) => it.slot === item.slot).measurement;
    const flagText = recorded.flags.length ? ` Flags: ${recorded.flags.join(", ")}.` : "";
    setHardwareStatus(statusEl,
      `Recorded tube ${item.slot} (${item.label}): ${formatFluorescence(recorded.fluorescence)} ${HARDWARE_FLUORESCENCE_UNIT}.${flagText}`,
      recorded.flags.length ? "warn" : "success");
  } catch (err) {
    console.error("Plan reading failed:", err);
    setHardwareStatus(statusEl, `Read failed for tube ${item.slot}: ${err.message}`, "error");
  } finally {
    planReading = false;
    renderPlan();
    // Keeps the run list's progress column from contradicting the run card right above it.
    refreshRuns();
    document.getElementById("plan-read-button").focus();
  }
}

// ---- no_plan: readings recorded earlier, entered by hand ------------------

// Two blanks and four standards, the fewest a dataset can hold. Only the types are set, never values.
const MANUAL_START_ROWS = ["blank", "blank", "standard", "standard", "standard", "standard"];

const manualRows = []; // { sample_type, concentration, signal }, the last two as typed
let manualDeviceState = "checking"; // checking | online | offline
let manualDeviceFingerprint = null;
let manualPollTimer = null;
let manualCreating = false;

function manualToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Number("") is 0, so an empty cell has to be caught before converting.
function manualNumber(text) {
  const trimmed = String(text).trim();
  return trimmed === "" ? NaN : Number(trimmed);
}

function manualPlural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
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
    firmware_version: value("manual-firmware"),
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
  if (!document.getElementById("manual-timepoint").value.trim()) return "Describe the timepoint.";
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

function updateManualControls() {
  const config = manualConfig();
  const { tubes, concentrations, blanks } = manualCounts();
  document.getElementById("manual-summary").textContent =
    `${manualPlural(tubes, "tube")}: ${manualPlural(concentrations, "concentration")}, ${manualPlural(blanks, "blank")}`;

  const fingerprintEl = document.getElementById("manual-fingerprint");
  fingerprintEl.textContent = "";
  if (config.fingerprint) {
    fingerprintEl.append("Config fingerprint ", hwFingerprint(config.fingerprint));
    if (manualConfigMode() === "manual" && manualDeviceFingerprint) {
      if (config.fingerprint === manualDeviceFingerprint) {
        fingerprintEl.append(" · matches the instrument now");
      } else {
        fingerprintEl.append(" · the instrument now runs ", hwFingerprint(manualDeviceFingerprint),
          ", so a curve from this dataset can't be set as active until they match");
      }
    }
  }

  const button = document.getElementById("manual-create-button");
  setBlocked(button, document.getElementById("manual-create-reason"), manualProblem(config));
  if (manualCreating) button.disabled = true;
}

async function refreshManualDevice() {
  try {
    manualDeviceFingerprint = (await HardwareApi.getDeviceStatus()).config.fingerprint;
    manualDeviceState = "online";
  } catch (err) {
    manualDeviceFingerprint = null;
    manualDeviceState = "offline";
  }
  updateManualControls();
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
  updateManualControls();
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
      updateManualControls();
    });

    const tr = hwEl("tr");
    tr.append(
      hwEl("td", null, String(n)),
      cell(type),
      cell(concentration.input),
      cell(signal.input),
      cell(remove, "action-cell"),
    );
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
  updateManualControls();
  refreshManualDevice();
  manualPollTimer = setInterval(refreshManualDevice, DEVICE_STATUS_POLL_INTERVAL_MS);
}

function stopManualEntry() {
  clearInterval(manualPollTimer);
  manualPollTimer = null;
}

async function createManualDataset(event) {
  event.preventDefault();
  const button = document.getElementById("manual-create-button");
  const statusEl = document.getElementById("manual-create-status");
  if (button.disabled) return;

  manualCreating = true;
  updateManualControls();
  setHardwareStatus(statusEl, "Creating dataset...", null);

  try {
    const created = await HardwareApi.createManualDataset({
      timepoint: document.getElementById("manual-timepoint").value,
      measured_on: document.getElementById("manual-measured-on").value,
      config: manualConfigMode() === "manual" ? manualConfigValues() : null,
      rows: manualRows.map((row) => ({
        sample_type: row.sample_type,
        concentration_nM: row.sample_type === "standard" ? manualNumber(row.concentration) : null,
        fluorescence: manualNumber(row.signal),
      })),
    });
    hardwareRemember(HARDWARE_LAST_PLAN_KEY, created.plan_id);
    window.location.href = `hardware-calibration-fit.html?plan=${encodeURIComponent(created.plan_id)}`;
  } catch (err) {
    console.error("Dataset creation failed:", err);
    manualCreating = false;
    updateManualControls();
    setHardwareStatus(statusEl, `Could not create dataset: ${err.message}`, "error");
  }
}

// ---- Saved runs: the list, a CSV per run, and the JSON backup ------------------
// A run holds the readings a curve was fitted from, and until the backend stores anything they
// exist only in this browser. This list is also the only way to reach a run other than the last
// one, and the only place a run restored on the Status page shows up. The CSV here is for reading
// and analysing one run; the backup that protects them all is on the Status page.

const RUNS_CSV_HEADERS = [
  "plan_id", "plan_source", "plan_timepoint", "plan_config_fingerprint", "plan_measured_on",
  "slot", "label", "sample_type", "concentration_nM",
  "sample_id", "timestamp_utc", "fluorescence", "fluorescence_sd", "scatter",
  "flags", "config_fingerprint", "source",
  ...HARDWARE_CHANNELS.map(({ key }) => key),
];

// One row per tube, read or not: an unread slot is part of what happened to the run.
function runCsvRows(plan) {
  return plan.items.map((item) => {
    const m = item.measurement;
    const raw = m?.raw ?? {};
    return [
      plan.plan_id, plan.source, plan.timepoint, plan.config_fingerprint, plan.measured_on,
      item.slot, item.label, item.sample_type, item.concentration_nM,
      m?.sample_id ?? null, m?.timestamp_utc ?? null, m?.fluorescence ?? null,
      m?.fluorescence_sd ?? null, m?.scatter ?? null,
      m ? m.flags.join(";") : null, m?.config_fingerprint ?? null, m?.source ?? null,
      ...HARDWARE_CHANNELS.map(({ key }) => raw[key] ?? null),
    ];
  });
}

function renderRuns(plans) {
  document.getElementById("runs-empty").hidden = plans.length > 0;
  document.getElementById("runs-table-wrapper").hidden = plans.length === 0;
  const tbody = document.getElementById("runs-table-body");
  tbody.innerHTML = "";

  for (const summary of plans) {
    // A manual dataset can't be re-read, so it opens straight on the fit page — the same place
    // openPlan() would forward it to anyway.
    const href = summary.source === "manual"
      ? `hardware-calibration-fit.html?plan=${encodeURIComponent(summary.plan_id)}`
      : `hardware-calibration.html?plan=${encodeURIComponent(summary.plan_id)}`;

    const csv = hwEl("button", "btn-secondary table-button", "CSV");
    csv.type = "button";
    csv.setAttribute("aria-label", `Export run ${summary.plan_id} as CSV`);
    csv.addEventListener("click", () => exportRunCsv(summary.plan_id, csv));

    const actions = hwEl("td", "action-cell");
    actions.append(hwLink(href, "Open"), csv);

    const config = hwEl("td");
    config.appendChild(hwFingerprint(summary.config_fingerprint));

    const row = hwEl("tr");
    row.append(
      hwEl("td", null, summary.plan_id),
      hwEl("td", null, formatLocalTime(summary.created_at)),
      hwEl("td", null, summary.timepoint),
      hwEl("td", null, summary.source === "manual" ? "Manual entry" : "Instrument readings"),
      config,
      hwEl("td", null, `${summary.read} / ${summary.total}`),
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
  const manualForm = document.getElementById("manual-form");
  manualForm.addEventListener("submit", createManualDataset);
  manualForm.addEventListener("input", updateManualControls);
  manualForm.addEventListener("change", (event) => {
    if (event.target.name === "manual-config-mode") {
      document.getElementById("manual-config-fields").hidden = manualConfigMode() !== "manual";
    }
    updateManualControls();
  });
  document.getElementById("manual-add-row").addEventListener("click", addManualRow);

  const form = document.getElementById("plan-form");
  form.addEventListener("submit", createPlan);
  form.addEventListener("input", updatePlanPreview);

  document.getElementById("plan-read-button").addEventListener("click", readPlanTarget);
  document.getElementById("plan-cancel-reread").addEventListener("click", () => {
    rereadSlot = null;
    setHardwareStatus(document.getElementById("plan-read-status"), "", null);
    renderPlan();
  });
  document.getElementById("plan-fit-button").addEventListener("click", () => {
    window.location.href = `hardware-calibration-fit.html?plan=${encodeURIComponent(plan.plan_id)}`;
  });

  refreshRuns();

  const planId = hardwareQueryParam("plan");
  if (planId) openPlan(planId);
  else showCreateForm();
});
