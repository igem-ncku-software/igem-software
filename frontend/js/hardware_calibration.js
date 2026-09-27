// =========================================================
// Backs hardware-calibration.html: step 2 of the CAPTURE-Screen workflow. One page walks a
// calibration run through five numbered steps, data before processing:
//   1 Source  read on CAPTURE-Screen, or enter readings recorded earlier. The instrument's status
//             is shown live, and it is pre-selected when it comes online before a choice is made
//   2 Set up  conditions (biosensor strain, notes), then either the standards to read
//             (with the reading order previewed) or when and under which config recorded
//             readings were taken
//   3 Read    the next tube pinned at the top; Read measures it, records it, and moves on.
//             For recorded data this step is Enter values instead: the readings are typed in row
//             by row, and Create run stores them as a run in one go
//   4 Fit     4PL, with any tube excluded only with a reason
//   5 Save    the curve, bound to the run's config, signal and conditions
// The instrument is polled every DEVICE_STATUS_POLL_INTERVAL_MS in every state, so Source, Create
// run and Read follow it (online, offline, sensor fault, config change) without a reload.
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
let planCurves = [];              // curves already saved from this run
let rereadSlot = null;            // the slot the user pressed Re-read on; null means measure the "next tube"
let planReading = false;
let lastReadSlot = null;          // the tube read last in this session, drawn gold on step 3's chart
let readChart = null;

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

// ---- The instrument, polled -----------------------------------------------

let deviceState = "checking";  // checking | online | offline
let deviceFingerprint = null;  // null unless online: the config can't be confirmed
let deviceSensorOk = null;     // DeviceStatus.sensor_ok; null = not online, or a firmware that doesn't report it
let deviceError = null;        // why it isn't online, in words
let deviceLastSeen = null;     // when an offline instrument last reported; null if it never has, or it's online
let sourceTouched = false;     // the user picked a source: never pre-select over their choice

function deviceSnapshot() {
  return [deviceState, deviceFingerprint, deviceSensorOk, deviceError, deviceLastSeen].join("|");
}

async function refreshDevice() {
  const before = deviceSnapshot();
  try {
    const status = await HardwareApi.getDeviceStatus();
    deviceState = "online";
    deviceFingerprint = status.config.fingerprint;
    deviceSensorOk = status.sensor_ok;
    deviceError = null;
    deviceLastSeen = null;
  } catch (err) {
    deviceState = "offline";
    deviceFingerprint = null;
    deviceSensorOk = null;
    deviceLastSeen = err.deviceOffline ? err.lastSeen : null;
    // The API's own offline message formats last_seen in the browser locale; this page uses the fixed format.
    deviceError = err.deviceOffline && err.lastSeen ? `CAPTURE-Screen is offline (last seen ${formatLocalTime(err.lastSeen)}).` : err.message;
  }
  applyDevice(before !== deviceSnapshot());
}

// What the instrument's status feeds: the Source choice, Create run, and an open run's Read step.
function applyDevice(changed) {
  renderDeviceStatus(document.getElementById("source-device-status"), true);
  if (!plan) {
    if (!sourceTouched && !setupSource() && deviceState === "online") selectSource("device");
    updateSetupControls();
  } else if (changed && !planReading) {
    renderSourceSummary();
    renderRead();
  }
}

// A time from today as the clock alone; any other day in full. Both in the fixed 24-hour format.
function formatSeenTime(utc) {
  const d = new Date(utc);
  return d.toDateString() === new Date().toDateString() ? formatClockTime(d) : formatLocalTime(utc);
}

// The instrument's status line: a health dot, then online with config and sensor, or why not.
// withHint (Source, before a run exists) adds that an offline instrument doesn't stop Set up:
// the page polls, and Create run unblocks by itself when it comes online.
function renderDeviceStatus(el, withHint = false) {
  const dot = hwEl("span", "status-dot");
  dot.setAttribute("aria-hidden", "true");
  const text = hwEl("span");
  el.replaceChildren(dot, text);
  if (deviceState === "checking") {
    text.textContent = "Checking the instrument...";
    return;
  }
  if (deviceState === "offline") {
    text.append(deviceLastSeen ? `Offline · last seen ${formatSeenTime(deviceLastSeen)}.` : deviceError);
    if (withHint) text.append(" You can fill in Set up now; Create run waits for it.");
    text.append(" ", hwLink("hardware.html", "Check on Instrument →"));
    return;
  }
  const sensor = sensorReading(deviceSensorOk);
  dot.classList.add(sensor.blocks ? "is-error" : "is-ok");
  text.append("Online · config ", hwFingerprint(deviceFingerprint), ` · sensor ${sensor.text.toLowerCase()}`);
  if (sensor.blocks) text.append(" ", hwLink("hardware.html", "Check on Instrument →"));
}

// ---- 1. Source --------------------------------------------------------

function setupSource() {
  return document.querySelector('input[name="setup-source"]:checked')?.value ?? null;
}

function selectSource(value) {
  document.querySelector(`input[name="setup-source"][value="${value}"]`).checked = true;
}

function renderSourceSummary() {
  const manual = plan.source === "manual";
  document.getElementById("source-summary-title").textContent = manual ? "Enter recorded data" : "Read on CAPTURE-Screen";
  const status = document.getElementById("source-summary-status");
  if (manual) status.textContent = `Measured ${plan.measured_on}.`;
  else renderDeviceStatus(status);
}

// ---- 2. Set up --------------------------------------------------------

// What to have ready for Set up: the cells for an instrument run; for recorded data, the records.
function showSetupBench(manual) {
  document.querySelector("#setup-bench span").textContent = manual
    ? "Your records of the readings: the date and the instrument settings used."
    : "Biosensor cells induced with each AHL standard, and cell blanks without AHL.";
}

// Step 3 is Read for an instrument run and Enter values for recorded data.
function showReadStep(manual, entering) {
  document.getElementById("read-label").textContent = manual ? "Enter values" : "Read";
  document.getElementById("read-title").textContent = manual ? "Recorded standards and blanks" : "Standards and blanks";
  document.querySelector("#read-bench span").textContent = manual
    ? "The recorded readings, one value per tube."
    : "One cuvette per tube, read in the order listed.";
  document.getElementById("manual-entry").hidden = !entering;
  document.getElementById("read-area").hidden = entering;
}

function setupConditions() {
  return {
    sensor: document.getElementById("cond-sensor").value.trim(),
    notes: document.getElementById("cond-notes").value.trim(),
  };
}

function conditionsProblem(c) {
  if (!c.sensor) return "Enter the biosensor strain.";
  return null;
}

function planInput() {
  return {
    concentrations_nM: parseConcentrationList(document.getElementById("plan-concentrations").value),
    replicates: Number(document.getElementById("plan-replicates").value),
    blanks: Number(document.getElementById("plan-blanks").value),
  };
}

// Shows the tube list Create run would make, in reading order, and returns what blocks it, or null.
// The list comes from the same code that creates the run, so it can't disagree with it.
function updatePlanPreview() {
  const preview = document.getElementById("plan-preview");
  const order = document.getElementById("plan-order");
  const input = planInput();
  let items;
  try {
    items = HardwareApi.previewCalibrationPlan(input);
  } catch (err) {
    preview.textContent = "";
    order.hidden = true;
    return err.message;
  }
  const concentrations = new Set(items.filter((it) => it.sample_type === "standard").map((it) => it.concentration_nM));
  preview.textContent = `${plural(items.length, "tube")}: ${plural(concentrations.size, "concentration")} × `
    + `${plural(input.replicates, "replicate")} + ${plural(input.blanks, "blank")}`;
  const list = document.getElementById("plan-order-list");
  list.replaceChildren(...items.map((it) => hwEl("li", null, it.label)));
  order.hidden = false;
  return null;
}

// Steps 1 to 3 while no run is open. An instrument run is created at step 2; recorded data is
// created at step 3, which opens as soon as step 2 is complete.
function updateSetupControls() {
  if (plan) return; // a status poll can land after a run has opened
  const source = setupSource();
  const manual = source === "manual";
  const sourceCard = document.getElementById("source-card");
  const setupCard = document.getElementById("setup-card");
  const readCard = document.getElementById("read-card");
  showSetupBench(manual);
  showReadStep(manual, manual);

  if (!source) {
    setStepCard(sourceCard, "current");
    for (const id of ["setup-card", "read-card", "fit-card", "save-card"]) {
      setStepCard(document.getElementById(id), "waiting", "Choose a data source first.");
    }
    return;
  }
  setStepCard(sourceCard, "done");
  document.getElementById("device-fields").hidden = manual;
  document.getElementById("manual-fields").hidden = !manual;
  document.getElementById("setup-create-button").hidden = manual;
  document.getElementById("setup-next-button").hidden = !manual;

  let problem = conditionsProblem(setupConditions());
  if (!manual) {
    const planProblem = updatePlanPreview(); // always, so the tube list shows while conditions are still empty
    problem = problem ?? planProblem;
    // A run is bound to the instrument's config when it is created, so the instrument has to answer.
    if (deviceState === "checking") problem = problem ?? "Checking the instrument...";
    if (deviceState === "offline") problem = problem ?? `${deviceError.replace(/\.?$/, ".")} Or enter recorded data instead.`;
    const button = document.getElementById("setup-create-button");
    setBlocked(button, document.getElementById("setup-create-reason"), problem);
    if (manualCreating) button.disabled = true;
    setStepCard(setupCard, "current");
    setStepCard(readCard, "waiting", "Create a run first.");
  } else {
    const manualState = updateManualControls();
    problem = problem ?? manualState.setup;
    const next = document.getElementById("setup-next-button");
    setBlocked(next, document.getElementById("setup-create-reason"), problem);
    setStepCard(setupCard, problem ? "current" : "done");
    setStepCard(readCard, problem ? "waiting" : "current", problem ? `Complete Set up first: ${problem}` : null);
    const button = document.getElementById("manual-create-button");
    setBlocked(button, document.getElementById("manual-create-reason"), problem ?? manualState.rows);
    if (manualCreating) button.disabled = true;
  }
  const waiting = manual ? "Enter the values and create the run first." : "Create a run first.";
  for (const id of ["fit-card", "save-card"]) setStepCard(document.getElementById(id), "waiting", waiting);
}

async function showSetup(errorText) {
  plan = null;
  document.getElementById("setup-title").textContent = "New calibration run";
  document.getElementById("source-choice").hidden = false;
  document.getElementById("source-summary").hidden = true;
  document.getElementById("setup-form-area").hidden = false;
  document.getElementById("setup-summary").hidden = true;
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

// An instrument run is created from step 2's form, recorded data from step 3's Create run.
async function createFromSetup(event) {
  event.preventDefault();
  if (setupSource() !== "device") {
    // Enter in a step-2 field: for recorded data that means on to step 3, when Set up allows it.
    if (!document.getElementById("setup-next-button").disabled) goToManualEntry();
    return;
  }
  await createRun(document.getElementById("setup-create-button"), document.getElementById("setup-status"));
}

// Set up is complete for recorded data: bring step 3 into view with the cursor in the first value.
function goToManualEntry() {
  document.querySelector('[data-manual-signal="0"]')?.focus({ preventScroll: true });
  document.getElementById("read-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function createRun(button, statusEl) {
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
  if (plan.conditions.notes) appendKvRow(tbody, "Notes", plan.conditions.notes);
  if (manual) appendKvRow(tbody, "Measured on", plan.measured_on);
  appendKvRow(tbody, "Config", hwFingerprint(plan.config_fingerprint));
  appendKvRow(tbody, "Signal", plan.signal);
  appendKvRow(tbody, "Created", formatLocalTime(plan.created_at));
}

// ---- 3. Read ----------------------------------------------------------

// An instrument run is read only under the config it was created with: a reading under another
// one would be stored flagged STALE_CONFIG and could never be fitted, so the tube would be wasted.
// Offline is said by the Read button's own reason, so this speaks only to a confirmed config.
function configMismatch() {
  return plan.source === "device" && deviceFingerprint !== null && deviceFingerprint !== plan.config_fingerprint;
}

function renderConfigWarning() {
  const warning = document.getElementById("plan-config-warning");
  warning.hidden = !configMismatch();
  if (!warning.hidden) {
    setHardwareStatus(warning,
      `The instrument now runs config ${deviceFingerprint}, not this run's ${plan.config_fingerprint}, so reading is blocked: `
      + "a reading under another config can't be fitted. Set the instrument back, or start a new run.",
      "error");
  }
}

// Why Read can't run now, or null.
function readBlockReason() {
  if (deviceState === "checking") return "Checking the instrument...";
  if (deviceState === "offline") return deviceError;
  const sensorBlock = sensorReading(deviceSensorOk).blocks;
  if (sensorBlock) return sensorBlock;
  if (configMismatch()) return `The instrument's config ${deviceFingerprint} isn't this run's ${plan.config_fingerprint}.`;
  return null;
}

// Step 3's view of the data so far: every standard read, on the fit chart's axes and without a
// fit. The x axis spans the whole plan from the first point, so it doesn't jump as tubes are read.
function renderReadChart() {
  const plate = document.getElementById("read-chart-plate");
  const standards = plan.items.filter((it) => it.sample_type === "standard");
  const read = standards.filter((it) => it.measurement);
  if (readChart) {
    readChart.destroy();
    readChart = null;
  }
  plate.hidden = plan.source !== "device" || read.length === 0;
  if (plate.hidden) return;

  const accent = cssVar("--accent");
  const gold = cssVar("--gold");
  const ink = cssVar("--text");
  const muted = cssVar("--muted");
  const rule = cssVar("--border");
  const toPoint = (it) => ({ x: it.concentration_nM, y: it.measurement.fluorescence });
  const concs = standards.map((it) => it.concentration_nM);
  const xMin = Math.min(...concs);
  const xMax = Math.max(...concs);

  const datasets = [
    { label: "Tube", data: read.filter((it) => it.slot !== lastReadSlot).map(toPoint), pointRadius: 3.5, pointBackgroundColor: accent, pointBorderColor: accent },
    { label: "Last read", data: read.filter((it) => it.slot === lastReadSlot).map(toPoint), pointRadius: 6, pointBackgroundColor: gold, pointBorderColor: gold },
  ];
  const blanks = plan.items.filter((it) => it.sample_type === "blank" && it.measurement).map((it) => it.measurement.fluorescence);
  if (blanks.length) {
    const blankMean = fitMean(blanks);
    datasets.push({
      label: "Blank mean", data: [{ x: xMin, y: blankMean }, { x: xMax, y: blankMean }],
      type: "line", pointRadius: 0, borderWidth: 1.5, borderDash: [6, 4], borderColor: muted,
    });
  }

  readChart = new Chart(document.getElementById("read-chart"), {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      aspectRatio: 2.8,
      animation: false,
      scales: {
        x: {
          type: "logarithmic", min: xMin, max: xMax,
          title: { display: true, text: "Concentration (nM, log scale)", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
        y: {
          title: { display: true, text: `${plan.signal} (${HARDWARE_FLUORESCENCE_UNIT})`, color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
      },
      plugins: { legend: { labels: { color: ink } } },
    },
  });
}

// Every tube is read: step 3 is done, so its button moves on to Fit.
function goToFit() {
  document.getElementById("fit-button").focus({ preventScroll: true });
  document.getElementById("fit-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRead() {
  const manual = plan.source === "manual";
  const total = plan.items.length;
  const read = plan.items.filter((it) => it.measurement).length;
  const target = manual ? null : targetItem();

  document.getElementById("next-tube").hidden = manual;
  renderConfigWarning();
  renderReadChart();
  if (!manual) {
    const banner = document.getElementById("next-tube");
    const label = document.getElementById("next-tube-label");
    const value = document.getElementById("next-tube-value");
    banner.classList.toggle("is-reread", rereadSlot !== null);
    banner.classList.toggle("is-done", !target);
    const action = document.getElementById("next-tube-action");
    if (rereadSlot !== null) {
      label.textContent = "Re-read";
      value.textContent = `${target.label} (tube ${target.slot} of ${total})`;
      action.textContent = "Put this cuvette back in, close the lid, then press Read.";
    } else if (target) {
      label.textContent = "Next tube";
      value.textContent = `${target.label} (tube ${target.slot} of ${total})`;
      action.textContent = "Insert this cuvette, close the lid, then press Read.";
    } else {
      label.textContent = "All tubes read";
      value.textContent = `${total} / ${total} tubes read.`;
      action.textContent = "";
    }
    action.hidden = !target;
    document.getElementById("plan-cancel-reread").hidden = rereadSlot === null;

    const progress = document.getElementById("plan-progress");
    progress.setAttribute("aria-valuemax", String(total));
    progress.setAttribute("aria-valuenow", String(read));
    document.getElementById("plan-progress-fill").style.width = `${(read / total) * 100}%`;
    document.getElementById("plan-progress-text").textContent = `${read} / ${total} read (${formatPercent(read / total)})`;

    const readButton = document.getElementById("plan-read-button");
    const nextButton = document.getElementById("plan-next-button");
    const reasonEl = document.getElementById("plan-read-reason");
    readButton.textContent = target ? `Read ${target.label}` : "Read";
    readButton.hidden = !target;
    nextButton.hidden = Boolean(target);
    if (target) {
      setBlocked(readButton, reasonEl, readBlockReason());
    } else {
      setBlocked(readButton, reasonEl, null);
      reasonEl.textContent = "To replace a reading, use Re-read on its row.";
      reasonEl.hidden = false;
    }
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
        setHardwareStatus(document.getElementById("plan-read-status"), "", null);
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

  try {
    // Inside the try on purpose: an exception here must still reach `finally` and reset
    // planReading, or a rendering bug leaves Read disabled for good, with no request sent and
    // nothing on screen saying why.
    renderAll();
    setHardwareStatus(statusEl, `Reading tube ${item.slot} (${item.label})...`, null);

    const input = {
      sample_id: `${plan.plan_id}-${String(item.slot).padStart(2, "0")}`,
      sample_type: item.sample_type,
    };
    if (item.sample_type === "standard") input.known_concentration_nM = item.concentration_nM;

    const [m, status] = await Promise.all([HardwareApi.readSample(input), HardwareApi.getDeviceStatus()]);
    deviceState = "online";
    deviceFingerprint = status.config.fingerprint;
    deviceSensorOk = status.sensor_ok;
    deviceError = null;
    plan = await HardwareApi.recordPlanMeasurement(plan.plan_id, item.slot, m);
    lastReadSlot = item.slot;
    rereadSlot = null;
    // The data under any fit just changed, so the fit no longer describes it.
    if (fitState !== "unfitted") discardFit();

    const recorded = plan.items.find((it) => it.slot === item.slot).measurement;
    const flagText = recorded.flags.length ? ` Flags: ${recorded.flags.join(", ")}.` : "";
    // The same concentration's other tubes, so an odd value is caught while the cuvette is still in hand.
    const replicates = plan.items.filter((it) => it.slot !== item.slot && it.measurement
      && it.sample_type === item.sample_type && it.concentration_nM === item.concentration_nM);
    const replicateText = replicates.length
      ? ` Replicates: ${replicates.map((it) => `${it.label} ${formatFluorescence(it.measurement.fluorescence)}`).join(", ")}.`
      : "";
    setHardwareStatus(statusEl,
      `Recorded tube ${item.slot} (${item.label}): ${formatFluorescence(recorded.fluorescence)} ${HARDWARE_FLUORESCENCE_UNIT}.${replicateText}${flagText}`,
      recorded.flags.length ? "warn" : "success");
  } catch (err) {
    console.error("Run reading failed:", err);
    setHardwareStatus(statusEl, `Read failed for tube ${item.slot}: ${err.message}`, "error");
    refreshDevice(); // the failure may be the instrument going offline: say so at the button
  } finally {
    planReading = false;
    renderAll();
    // Keeps the run list's progress column from contradicting the run card right above it.
    refreshRuns();
    if (planComplete(plan)) refreshHardwareSteps();
    // Enter keeps working: it reads the next tube, or after the last one moves on to Fit.
    document.getElementById(targetItem() ? "plan-read-button" : "plan-next-button").focus();
  }
}

// ---- 4. Fit -------------------------------------------------------------

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
  return item.measurement !== null && fitExclusions.has(item.measurement.sample_id);
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

// A counted tube read under a config other than the run's: fitCurve refuses the run until it is
// excluded (or re-read under the run's config). Marked in the table.
function isStaleTube(item) {
  return !isExcluded(item) && item.measurement.config_fingerprint !== plan.config_fingerprint;
}

// Why Fit can't run, or null. The data checks are fitCurve's own refusals, made here as soon as an
// exclusion changes, so a Fit press never ends in an error that ticking a box could have shown.
function blockedFitReason() {
  if (fitState === "fitted") return "Already fitted with these exclusions. Change an exclusion to fit again.";
  if (fitState === "saved") return "This fit is saved. Use “Fit again with different exclusions” below to start a new one.";
  // Every check below reads a tube's own measurement, so none of them can run until every tube
  // has one: an unread tube's measurement is null. renderAll() calls this on every render, not
  // only once the Fit step is open.
  const pending = plan.items.filter((it) => !it.measurement).length;
  if (pending > 0) return `${plural(pending, "tube")} still unread.`;
  const counted = plan.items.filter((it) => !isExcluded(it));
  const stale = counted.filter((it) => it.measurement.config_fingerprint !== plan.config_fingerprint).length;
  if (stale > 0) return `${plural(stale, "tube")} read under another config (marked). Exclude or re-read them.`;
  const blanks = counted.filter((it) => it.sample_type === "blank").length;
  if (blanks < 2) return `The counted tubes include ${plural(blanks, "blank")}; LOD needs at least 2.`;
  const concentrations = new Set(counted.filter((it) => it.sample_type === "standard").map((it) => it.concentration_nM)).size;
  if (concentrations < 4) return `The counted tubes cover ${plural(concentrations, "concentration")}; a 4PL fit needs at least 4.`;
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
      row.classList.toggle("is-problem", isStaleTube(item));

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
    setHardwareStatus(statusEl, "Fitted.", "success"); // the numbers are in the tiles below
  } catch (err) {
    console.error("Fit failed:", err);
    setHardwareStatus(statusEl, `Fit failed: ${err.message}`, "error");
  } finally {
    fitBusy = false;
    renderAll();
    // Enter keeps working: after a fit it moves on to Save.
    if (fitState === "fitted") document.getElementById("fit-next-button").focus();
  }
}

function goToSave() {
  document.getElementById("save-button").focus({ preventScroll: true });
  document.getElementById("save-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- 5. Save ---------------------------------------------------------

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
  const fitted = fitState === "fitted";
  fitButton.hidden = fitted;
  document.getElementById("fit-next-button").hidden = !fitted;
  setBlocked(fitButton, document.getElementById("fit-reason"), fitted ? null : blockedFitReason());
  if (fitBusy) fitButton.disabled = true;

  const saveButton = document.getElementById("save-button");
  saveButton.hidden = !fitted;
  setBlocked(saveButton, document.getElementById("save-reason"), fitted ? blockedSaveReason() : null);
  if (fitBusy) saveButton.disabled = true;

  // Before saving: the numbers that define the curve, and what it is bound to.
  document.getElementById("save-summary").hidden = !fitted;
  if (fitted) {
    const curve = fitCurveResult;
    document.getElementById("save-facts").textContent =
      `EC50 ${formatConcentration(curve.params.ec50_nM)} · LOD ${formatConcentration(curve.lod_nM)} · `
      + `usable ${formatConcentrationInterval([curve.range_nM.min, curve.range_nM.max])} · `
      + `${plural(fitExclusions.size, "tube")} excluded`;
    const binding = document.getElementById("save-binding");
    binding.textContent = "";
    binding.append(`Strain ${plan.conditions.sensor} · Config `, hwFingerprint(plan.config_fingerprint), ` · Signal ${plan.signal}`);
  }

  // Once a curve from this run exists, the step's one way on is the next workflow step, Curves,
  // with the reminder that the curve lives only in this browser.
  const saved = !fitted && planCurves.length > 0;
  document.getElementById("save-next-button").hidden = !saved;
  document.getElementById("save-backup").hidden = !saved;

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
    // Enter keeps working: after saving it moves on to Curves.
    if (fitState === "saved") document.getElementById("save-next-button").focus();
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

  renderSourceSummary();
  setStepCard(document.getElementById("source-card"), "done");
  renderSetupSummary();
  showSetupBench(plan.source === "manual");
  setStepCard(document.getElementById("setup-card"), "done");

  showReadStep(plan.source === "manual", false);
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
  // The run lives in the browser: it still opens when the device is unreachable, just without a config check.
  const [planResult, , curvesResult] = await Promise.allSettled([
    alreadyLoaded ? Promise.resolve(alreadyLoaded) : HardwareApi.getCalibrationPlan(planId),
    refreshDevice(),
    HardwareApi.listCurves(),
  ]);

  if (planResult.status === "rejected") {
    console.error("Failed to load run:", planResult.reason);
    history.replaceState(null, "", "hardware-calibration.html");
    showSetup(`Could not load run ${planId}: ${planResult.reason.message}`);
    return;
  }
  plan = planResult.value;
  planCurves = curvesResult.status === "fulfilled" ? curvesResult.value.filter((curve) => curve.plan_id === plan.plan_id) : [];
  hardwareRemember(HARDWARE_LAST_PLAN_KEY, plan.plan_id);

  document.getElementById("source-choice").hidden = true;
  document.getElementById("source-summary").hidden = false;
  document.getElementById("setup-form-area").hidden = true;
  document.getElementById("setup-summary").hidden = false;
  renderAll();
  refreshRuns();
  // Straight to the step that is next. Focusing Read scrolls to it and lets Enter read the first tube.
  const readButton = document.getElementById("plan-read-button");
  if (plan.source === "device" && !planComplete(plan) && !readButton.disabled) readButton.focus();
  else document.querySelector(".step-card[data-state='current']")?.scrollIntoView({ block: "start" });
}

// ---- Recorded data: Set up fields and step 3 entry ------------------

// Two blanks and four standards, the fewest a dataset can hold. Only the types are set, never values.
const MANUAL_START_ROWS = ["blank", "blank", "standard", "standard", "standard", "standard"];

const manualRows = []; // { sample_type, concentration, signal }, the last two as typed
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
    if (deviceState === "checking") return { error: "Checking the instrument's config..." };
    if (deviceState === "offline") {
      return { error: "Instrument unreachable, so its current config is unknown. Enter the config manually." };
    }
    return { fingerprint: deviceFingerprint };
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

// Step 1's part: when, and under which config.
function manualSetupProblem(config) {
  const measuredOn = document.getElementById("manual-measured-on").value;
  if (!measuredOn) return "Enter the date the readings were taken.";
  if (measuredOn > manualToday()) return "The measurement date is in the future.";
  return config.error ?? null;
}

// Step 2's part: the values themselves.
// Row numbers as "Row 3" or "Rows 2, 5–8".
function manualRowList(rows) {
  const parts = [];
  for (let i = 0; i < rows.length; i++) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    parts.push(j > i ? `${rows[i]}–${rows[j]}` : String(rows[i]));
    i = j;
  }
  return `${rows.length === 1 ? "Row" : "Rows"} ${parts.join(", ")}`;
}

// Every cell problem at once, grouped by what's wrong ("Rows 3–6: enter the signal."), so one
// fix doesn't just reveal the next. Then the table's minimum for a fit.
function manualRowsProblem() {
  const byProblem = new Map();
  manualRows.forEach((row, i) => {
    for (const field of ["concentration", "signal"]) {
      const problem = manualCellProblem(row, field);
      if (!problem) continue;
      if (!byProblem.has(problem)) byProblem.set(problem, []);
      byProblem.get(problem).push(i + 1);
    }
  });
  if (byProblem.size > 0) {
    return [...byProblem].map(([problem, rows]) => `${manualRowList(rows)}: ${problem}`).join(" ");
  }
  const { concentrations, blanks } = manualCounts();
  if (concentrations < 4) return "A 4PL fit needs at least 4 distinct concentrations.";
  if (blanks < 2) return "Enter at least 2 blanks: LOD needs a blank SD.";
  return null;
}

// Refreshes the manual-entry summary lines and returns what blocks each step, { setup, rows }, null when nothing.
function updateManualControls() {
  const config = manualConfig();
  const current = document.getElementById("manual-current-config");
  current.textContent = "";
  if (deviceState === "online") current.append("(config ", hwFingerprint(deviceFingerprint), ")");
  else current.textContent = deviceState === "checking" ? "(checking...)" : "(instrument offline)";
  document.getElementById("manual-current-note").hidden = manualConfigMode() !== "current";
  const { tubes, concentrations, blanks } = manualCounts();
  document.getElementById("manual-summary").textContent =
    `${plural(tubes, "tube")}: ${plural(concentrations, "concentration")}, ${plural(blanks, "blank")} · `
    + "a fit needs at least 4 concentrations and 2 blanks";

  const fingerprintEl = document.getElementById("manual-fingerprint");
  fingerprintEl.textContent = "";
  if (config.fingerprint) {
    fingerprintEl.append("Config fingerprint ", hwFingerprint(config.fingerprint));
    if (manualConfigMode() === "manual" && deviceFingerprint) {
      if (config.fingerprint === deviceFingerprint) {
        fingerprintEl.append(" · matches the instrument now");
      } else {
        fingerprintEl.append(" · the instrument now runs ", hwFingerprint(deviceFingerprint),
          ", so a curve from this dataset can't measure until they match");
      }
    }
  }
  return { setup: manualSetupProblem(config), rows: manualRowsProblem() };
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
  if (manualRows.length === 0) {
    for (const type of MANUAL_START_ROWS) manualRows.push({ sample_type: type, concentration: "", signal: "" });
  }
  document.getElementById("manual-measured-on").max = manualToday();
  renderManualRows();
}

// ---- Saved runs: the list and a CSV per run ------------------
// A run holds the readings a curve was fitted from, and until the backend stores anything they
// exist only in this browser. The CSV here is for reading and analysing one run; the backup that
// protects them all is on the Data page.

const RUNS_CSV_HEADERS = [
  "plan_id", "plan_source", "sensor", "notes", "plan_config_fingerprint", "plan_signal", "plan_measured_on",
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
      p.plan_id, p.source, p.conditions.sensor, p.conditions.notes,
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
  document.getElementById("source-choice").addEventListener("change", () => {
    sourceTouched = true;
    updateSetupControls();
  });
  document.getElementById("manual-add-row").addEventListener("click", addManualRow);
  document.getElementById("setup-next-button").addEventListener("click", goToManualEntry);
  document.getElementById("plan-next-button").addEventListener("click", goToFit);
  document.getElementById("fit-next-button").addEventListener("click", goToSave);
  document.getElementById("save-next-button").addEventListener("click", () => { location.href = "hardware-curves.html"; });
  document.getElementById("manual-entry").addEventListener("input", updateSetupControls);
  document.getElementById("manual-entry").addEventListener("change", updateSetupControls);
  document.getElementById("manual-create-button").addEventListener("click", (event) =>
    createRun(event.currentTarget, document.getElementById("manual-create-status")));

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
  setInterval(refreshDevice, DEVICE_STATUS_POLL_INTERVAL_MS);

  const planId = hardwareQueryParam("plan");
  if (planId) openPlan(planId);
  else {
    showSetup();
    refreshDevice();
  }
});
