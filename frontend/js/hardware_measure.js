// =========================================================
// Backs hardware-measure.html: step 4 of the CAPTURE-Screen workflow. A batch is one sitting at
// the instrument, walked through four numbered steps:
//   1 Curve    chosen once; only curves matching the instrument's config and signal can start one
//   2 Blank    the same cells without AHL, before any sample (and the HIGH_SCATTER baseline)
//   3 Samples  each sample read in replicate tubes, the next tube pinned at the top
//   4 Results  per sample, the mean of its counted tubes converted once, with a 95% CI
// A step that can't start yet stays visible with what it is waiting for.
//
// Every tube is stored the moment it is read — it is already spent — before anything is drawn.
// A tube can be left out only with a reason, and stays in the batch and the export. A numeric
// concentration appears only for status "ok": nothing is ever extrapolated outside the range.
//
// Target elements: #curve-card / #batch-* family, #blank-* family, #sample-* / #last-tube-* family,
//   #results-* family, #batches-* family
// Backing API: listCurves / getDeviceStatus / getCurrentSignal / createBatch / getBatch /
//   listBatches / readSample / recordBatchReading / setBatchTubeExclusion / finishBatch /
//   markBatchesExported
// =========================================================

let batch = null;
let deviceFingerprint = null;
let deviceSensorOk = null;
let deviceConfig = null;
let deviceError = null;   // why the instrument is unreachable, in words; null while it answers
let measureReading = false;
let finishConfirming = false; // the "Finishing is final" panel is open
let channelChart = null;
const openSamples = new Set();

// The instrument is polled every DEVICE_STATUS_POLL_INTERVAL_MS in every state, so the curve
// chooser and the Blank/Samples Read buttons follow it (online, offline, sensor fault, config
// change) without a reload - the same rule as Calibrate and Curves. Skipped mid-read: readTube
// already gets a fresh status alongside that read, and a poll landing then would just race it.
async function refreshDevice() {
  if (measureReading) return;
  const [statusResult, signalResult] = await Promise.allSettled([
    HardwareApi.getDeviceStatus(),
    HardwareApi.getCurrentSignal(),
  ]);
  const fingerprint = statusResult.status === "fulfilled" ? statusResult.value.config.fingerprint : null;
  const sensorOk = statusResult.status === "fulfilled" ? statusResult.value.sensor_ok : null;
  const config = statusResult.status === "fulfilled" ? statusResult.value.config : null;
  const error = statusResult.status === "rejected" ? statusResult.reason.message : null;
  const signal = signalResult.status === "fulfilled" ? signalResult.value : null;
  const changed = fingerprint !== deviceFingerprint || sensorOk !== deviceSensorOk
    || error !== deviceError || signal !== chooserSignal;
  deviceFingerprint = fingerprint;
  deviceSensorOk = sensorOk;
  deviceConfig = config;
  deviceError = error;
  chooserSignal = signal;
  if (!changed) return;
  if (batch) {
    renderBlank();
    renderSamples();
  } else {
    renderChooserStatus();
    renderCurveChoices();
    updateBatchStartControls();
  }
}

// ---- 1. Curve -------------------------------------------------------------

let chooserCurves = [];
let chooserSignal = null;
let chooserLoadError = null;   // why the curves couldn't be listed, or null

// The line above the curve list. Re-rendered by every device poll along with the list, so it
// never says "unreachable" over curves the instrument now accepts, or stays hidden once it doesn't.
function renderChooserStatus() {
  const statusEl = document.getElementById("batch-curves-status");
  statusEl.hidden = false;
  if (chooserLoadError) {
    setHardwareStatus(statusEl, `Couldn't load curves: ${chooserLoadError}`, "error");
  } else if (chooserCurves.length === 0) {
    setHardwareStatus(statusEl, "No saved curves yet. ", "warn");
    statusEl.appendChild(hwLink("hardware-calibration.html", "Calibrate →"));
  } else if (deviceFingerprint === null) {
    setHardwareStatus(statusEl, `Can't check curves against the instrument: ${deviceError ? hwClause(deviceError) : "no answer yet"}.`, "warn");
  } else {
    setHardwareStatus(statusEl, "", null);
    statusEl.hidden = true;
  }
}

function selectedCurveId() {
  return document.querySelector('input[name="batch-curve"]:checked')?.value ?? null;
}

function updateBatchStartControls() {
  let reason = null;
  if (chooserCurves.length === 0) reason = "No saved curves. Calibrate first.";
  else if (deviceFingerprint === null) reason = "Instrument unreachable, so no curve can be checked against its config.";
  else if (!selectedCurveId()) reason = "Choose a usable curve.";
  const tubes = Number(document.getElementById("batch-tubes").value);
  if (!reason && !(Number.isInteger(tubes) && tubes >= 1 && tubes <= 10)) reason = "Tubes per sample must be 1 to 10.";
  setBlocked(document.getElementById("batch-start-button"), document.getElementById("batch-start-reason"), reason);
}

async function showChooser() {
  batch = null;
  document.getElementById("batch-form").hidden = false;
  document.getElementById("batch-summary").hidden = true;
  document.getElementById("curve-title").textContent = "Choose a curve";
  setStepCard(document.getElementById("curve-card"), "current");
  for (const id of ["blank-card", "sample-card", "results-card", "export-card"]) {
    setStepCard(document.getElementById(id), "waiting", "Start a batch first.");
  }

  const [curvesResult, statusResult, signalResult] = await Promise.allSettled([
    HardwareApi.listCurves(),
    HardwareApi.getDeviceStatus(),
    HardwareApi.getCurrentSignal(),
  ]);
  chooserCurves = curvesResult.status === "fulfilled" ? curvesResult.value : [];
  chooserLoadError = curvesResult.status === "rejected" ? curvesResult.reason.message : null;
  deviceFingerprint = statusResult.status === "fulfilled" ? statusResult.value.config.fingerprint : null;
  deviceError = statusResult.status === "rejected" ? statusResult.reason.message : null;
  chooserSignal = signalResult.status === "fulfilled" ? signalResult.value : null;
  renderChooserStatus();

  // The curve asked for by ?curve= is picked when it can be; otherwise the newest usable one.
  renderCurveChoices(hardwareQueryParam("curve"));
  updateBatchStartControls();
}

// Rebuilds the curve list against the device's current fingerprint/signal. Keeps whichever curve
// is already selected as long as it's still usable; a curve that just became blocked is dropped
// (never left checked-but-disabled, since a disabled radio keeps its checked state, and
// updateBatchStartControls() only asks *whether* one is selected - it would wrongly count that as
// a usable choice). preselectId, given, is used only when nothing is selected yet.
function renderCurveChoices(preselectId) {
  const current = selectedCurveId();
  const usable = chooserCurves.filter((curve) => !curveBlockReason(curve, deviceFingerprint, chooserSignal));
  const wanted = current ?? preselectId;
  const preselect = usable.find((curve) => curve.curve_id === wanted) ?? (current ? null : usable[0] ?? null);

  const list = document.getElementById("batch-curve-list");
  list.innerHTML = "";
  for (const curve of chooserCurves) {
    const blocked = curveBlockReason(curve, deviceFingerprint, chooserSignal);
    const li = hwEl("li");
    const label = hwEl("label", "choice");
    const input = hwEl("input");
    input.type = "radio";
    input.name = "batch-curve";
    input.value = curve.curve_id;
    input.disabled = Boolean(blocked);
    input.checked = preselect?.curve_id === curve.curve_id;
    const text = hwEl("span");
    text.append(
      hwEl("span", "choice-title", `${formatConditions(curve.conditions)}`),
      hwEl("span", "choice-meta",
        `${curve.curve_id} · EC50 ${formatConcentration(curve.params.ec50_nM)} · LOD ${formatConcentration(curve.lod_nM)} · `
        + `usable range ${formatConcentrationInterval([curve.range_nM.min, curve.range_nM.max])} · fitted ${formatLocalTime(curve.fitted_at)}`),
    );
    if (blocked) text.appendChild(hwEl("span", "choice-meta", `Not usable: ${blocked}`));
    label.append(input, text);
    li.appendChild(label);
    list.appendChild(li);
  }
}

async function startBatch(event) {
  event.preventDefault();
  const button = document.getElementById("batch-start-button");
  const statusEl = document.getElementById("batch-start-status");
  if (button.disabled) return;

  button.disabled = true;
  setHardwareStatus(statusEl, "Starting batch…", null);
  try {
    const created = await HardwareApi.createBatch({
      curve_id: selectedCurveId(),
      tubes_per_sample: Number(document.getElementById("batch-tubes").value),
      notes: document.getElementById("batch-notes").value,
    });
    history.replaceState(null, "", `?batch=${encodeURIComponent(created.batch_id)}`);
    setHardwareStatus(statusEl, "", null);
    await openBatch(created.batch_id, created);
    refreshBatches();
    refreshHardwareSteps();
  } catch (err) {
    console.error("Could not start batch:", err);
    setHardwareStatus(statusEl, `Couldn't start the batch: ${err.message}`, "error");
    updateBatchStartControls();
  }
}

function renderBatchSummary() {
  document.getElementById("curve-title").textContent = batch.batch_id;
  const tbody = document.getElementById("batch-summary-body");
  tbody.innerHTML = "";
  const { curve } = batch;
  appendKvRow(tbody, "Biosensor strain", curve.conditions.sensor);
  const curveCell = hwEl("span");
  curveCell.append(`${curve.curve_id} · LOD ${formatConcentration(curve.lod_nM)} · usable range `
    + `${formatConcentrationInterval([curve.range_nM.min, curve.range_nM.max])}`);
  appendKvRow(tbody, "Curve", curveCell);
  const config = hwEl("span");
  config.append(hwFingerprint(curve.config_fingerprint), ` · signal ${curve.signal}`);
  appendKvRow(tbody, "Config", config);
  appendKvRow(tbody, "Tubes per sample", String(batch.tubes_per_sample));
  if (batch.notes) appendKvRow(tbody, "Notes", batch.notes);
  appendKvRow(tbody, "Started", formatLocalTime(batch.created_at));
  if (batch.finished_at) appendKvRow(tbody, "Finished", formatLocalTime(batch.finished_at));
}

// ---- Shared: why a read can't happen now ---------------------------------------

function readBlockReason() {
  if (batch.finished_at) return "This batch is finished. Start a new batch to read more.";
  if (deviceFingerprint === null) return deviceError ? `${hwClause(deviceError)}.` : "Checking the instrument…";
  const sensor = sensorReading(deviceSensorOk).blocks;
  if (sensor) return sensor;
  if (deviceFingerprint !== batch.curve.config_fingerprint) {
    return `The instrument now runs config ${deviceFingerprint}, not the curve's ${batch.curve.config_fingerprint}, so reading is blocked: a reading under another config wouldn't count.`;
  }
  return null;
}

// A tube is left out automatically when it was read under another config or signal; the user
// can't count it back in.
function tubeAutoExcluded(tube) {
  return tube.measurement.config_fingerprint !== batch.curve.config_fingerprint
    || tube.measurement.signal !== batch.curve.signal;
}

// "Counted", or the reason it isn't, plus the control to change that while the batch is open.
function tubeCountedCell(tube) {
  const td = hwEl("td");
  const m = tube.measurement;
  if (tube.excluded_reason !== null) {
    td.append(hwEl("span", "flag-chip warn", "Left out"), " ", hwEl("span", "cell-note", tube.excluded_reason));
    if (!batch.finished_at && !tubeAutoExcluded(tube)) {
      const back = hwEl("button", "btn-secondary table-button", "Count again");
      back.type = "button";
      back.addEventListener("click", () => setTubeExclusion(m.sample_id, null));
      td.append(" ", back);
    }
    return td;
  }
  td.appendChild(hwEl("span", "flag-chip ok", "Counted"));
  if (batch.finished_at) return td;
  const reason = hwEl("input", "table-input");
  reason.type = "text";
  reason.placeholder = "Reason to leave out";
  reason.setAttribute("aria-label", `Reason to leave out ${m.sample_id}`);
  const leave = hwEl("button", "btn-secondary table-button", "Leave out");
  leave.type = "button";
  leave.disabled = true;
  reason.addEventListener("input", () => { leave.disabled = !reason.value.trim(); });
  leave.addEventListener("click", () => setTubeExclusion(m.sample_id, reason.value));
  td.append(" ", reason, " ", leave);
  return td;
}

async function setTubeExclusion(sampleId, reason) {
  try {
    batch = await HardwareApi.setBatchTubeExclusion(batch.batch_id, sampleId, reason);
    setHardwareStatus(document.getElementById("results-status"),
      reason === null ? `${sampleId} counts again.` : `${sampleId} left out: ${reason.trim()}`, "success");
  } catch (err) {
    console.error("Could not change the tube:", err);
    setHardwareStatus(document.getElementById("results-status"), `Couldn't change ${sampleId}: ${err.message}`, "error");
  }
  renderBatch();
  refreshBatches();
}

// ---- 2. Blank -----------------------------------------------------------------

function renderBlank() {
  const counted = batch.blank_estimate.n;
  setStepCard(document.getElementById("blank-card"), counted > 0 ? "done" : "current");

  setBlocked(document.getElementById("blank-read-button"), document.getElementById("blank-read-reason"), readBlockReason());
  if (measureReading) document.getElementById("blank-read-button").disabled = true;

  // The blank should read below the curve's LOD. If it converts to a concentration, the cells,
  // the medium or the instrument has moved since the curve was made, and the samples would carry it.
  const check = document.getElementById("blank-check");
  const estimate = batch.blank_estimate;
  check.hidden = counted === 0;
  if (estimate.status === "below_lod") {
    setHardwareStatus(check, `Blank mean ${formatFluorescence(estimate.mean_signal)} ${HARDWARE_FLUORESCENCE_UNIT} reads below the curve's LOD, as it should.`, "success");
  } else if (estimate.status === "ok" || estimate.status === "above_range") {
    setHardwareStatus(check,
      `Blank mean reads as ${formatEstimate(estimate, batch.curve)} AHL. Check for AHL carry-over or drift before reading samples.`, "warn");
  }

  document.getElementById("blank-table-wrapper").hidden = batch.blanks.length === 0;
  const tbody = document.getElementById("blank-table-body");
  tbody.innerHTML = "";
  for (const tube of batch.blanks) {
    const m = tube.measurement;
    const qc = hwEl("td");
    qc.appendChild(renderFlagChips(m.flags));
    const row = hwEl("tr");
    row.classList.toggle("is-excluded", tube.excluded_reason !== null);
    row.append(
      hwEl("td", null, m.sample_id),
      hwEl("td", null, formatLocalTime(m.timestamp_utc)),
      hwEl("td", null, formatFluorescence(m.fluorescence)),
      hwEl("td", null, formatFluorescence(m.scatter)),
      qc,
      tubeCountedCell(tube),
    );
    tbody.appendChild(row);
  }
}

// ---- 3. Samples -----------------------------------------------------------------

function sampleTubeCount(name) {
  return batch.samples.find((s) => s.name === name)?.tubes.length ?? 0;
}

function nextSampleId(id) {
  const match = id.match(/^(.*?)(\d+)$/);
  if (!match) return `${id}-2`;
  return match[1] + String(Number(match[2]) + 1).padStart(match[2].length, "0");
}

function renderSamples() {
  const card = document.getElementById("sample-card");
  if (batch.blank_estimate.n === 0) {
    setStepCard(card, "waiting", "Read at least one blank first.");
    return;
  }
  setStepCard(card, batch.finished_at ? "done" : "current");

  const name = document.getElementById("sample-name").value.trim();
  const tube = sampleTubeCount(name) + 1;
  const n = batch.tubes_per_sample;
  document.getElementById("sample-next-value").textContent = !name
    ? "Enter a sample name"
    : tube <= n ? `${name} · tube ${tube} of ${n}` : `${name} · extra tube ${tube}`;
  document.getElementById("sample-next").classList.toggle("is-done", Boolean(batch.finished_at));

  const button = document.getElementById("sample-read-button");
  button.textContent = name ? `Read ${name} tube ${tube}` : "Read";
  setBlocked(button, document.getElementById("sample-read-reason"), readBlockReason() ?? (name ? null : "Enter the sample name."));
  if (measureReading) button.disabled = true;
  document.getElementById("sample-name").disabled = Boolean(batch.finished_at);
}

// ---- The last tube's detail: signal, flags, all ten channels, and the config it was read under ----

// Draws a text label above the F4 bar. Chart.js has no built-in annotation support,
// and the plugin would be a new dependency, so this draws it manually.
const channelAnnotationPlugin = {
  id: "channelAnnotations",
  afterDatasetsDraw(chart, _args, options) {
    const meta = chart.getDatasetMeta(0);
    const { ctx } = chart;
    HARDWARE_CHANNELS.forEach((channel, i) => {
      const note = options.annotations?.[channel.key];
      const bar = meta.data[i];
      if (!note || !bar) return;
      ctx.save();
      ctx.fillStyle = note.color;
      ctx.font = "700 12px 'Segoe UI', 'Noto Sans TC', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(note.text, bar.x, Math.min(bar.y, bar.base) - 6);
      ctx.restore();
    });
  },
};

function renderChannelChart(raw) {
  const canvas = document.getElementById("measure-channel-chart");
  if (channelChart) channelChart.destroy();

  const fluor = cssVar("--fluor");
  const accent = cssVar("--accent");
  const contextBar = cssVar("--chart-muted");
  const muted = cssVar("--muted");
  const ink = cssVar("--text");
  const rule = cssVar("--border");

  channelChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: HARDWARE_CHANNELS.map((channel) => channel.axis),
      datasets: [{
        label: "Basic counts",
        data: HARDWARE_CHANNELS.map(({ key }) => raw[key]),
        backgroundColor: HARDWARE_CHANNELS.map(({ key }) => (key === "F4" ? fluor : contextBar)),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      aspectRatio: 2.6,
      animation: false,
      layout: { padding: { top: 8 } },
      scales: {
        x: { title: { display: true, text: "Channel center wavelength (nm)", color: ink }, grid: { display: false }, ticks: { color: muted } },
        y: {
          beginAtZero: true,
          grace: "12%", // leaves room for the label text above the bars
          title: { display: true, text: "Basic counts (dark-subtracted)", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => `${formatFluorescence(context.parsed.y)} ${HARDWARE_FLUORESCENCE_UNIT}` } },
        channelAnnotations: { annotations: { F4: { text: "sfGFP", color: accent } } },
      },
    },
    plugins: [channelAnnotationPlugin],
  });
}

function renderProvenance(m) {
  const el = document.getElementById("last-tube-provenance");
  el.innerHTML = "";
  const item = (label, value) => {
    const span = hwEl("span");
    span.append(hwEl("b", null, `${label} `), value);
    el.appendChild(span);
  };
  // The current config details only describe this reading if the config hasn't changed; otherwise all that can be shown is the fingerprint.
  if (deviceConfig && deviceConfig.fingerprint === m.config_fingerprint) {
    item("LED", `${deviceConfig.led_current_mA} mA`);
    item("Gain", `${deviceConfig.gain}×`);
    item("ATIME / ASTEP", `${deviceConfig.atime} / ${deviceConfig.astep}`);
    item("Build", deviceConfig.build_id);
  } else {
    item("Config details", "unavailable (the instrument config changed after this read)");
  }
  item("Config", hwFingerprint(m.config_fingerprint));
}

function renderLastTube(m, label) {
  document.getElementById("last-tube").hidden = false;
  document.getElementById("last-tube-heading").textContent = `${label} · ${formatLocalTime(m.timestamp_utc)}`;
  document.getElementById("last-tube-signal-label").textContent = `sfGFP signal · ${m.signal}`;
  document.getElementById("last-tube-signal").textContent = `${formatFluorescence(m.fluorescence)} ± ${formatFluorescence(m.fluorescence_sd)}`;
  document.getElementById("last-tube-signal-sub").textContent =
    `${HARDWARE_FLUORESCENCE_UNIT} (± read-noise SD) · scatter ${formatFluorescence(m.scatter)}`;
  const flags = document.getElementById("last-tube-flags");
  flags.innerHTML = "";
  flags.appendChild(renderFlagChips(m.flags));
  renderChannelChart(m.raw);
  renderProvenance(m);
}

// ---- Reading a tube (blank or sample) -----------------------------------------------

async function readTube(role) {
  if (measureReading) return;
  const name = role === "sample" ? document.getElementById("sample-name").value.trim() : null;
  const statusEl = document.getElementById(role === "blank" ? "blank-status" : "sample-status");
  const index = role === "blank" ? batch.blanks.length + 1 : sampleTubeCount(name) + 1;
  const sampleId = role === "blank"
    ? `${batch.batch_id}-BLANK-${index}`
    : `${batch.batch_id}-${name}-${index}`;
  const label = role === "blank" ? `Blank ${index}` : `${name} tube ${index}`;

  measureReading = true;
  renderBatch();
  setHardwareStatus(statusEl, `Reading ${label}…`, null);

  let sensorOk;
  try {
    const [m, status] = await Promise.all([
      HardwareApi.readSample({ sample_id: sampleId, sample_type: role === "blank" ? "blank" : "unknown" }),
      HardwareApi.getDeviceStatus(),
    ]);
    sensorOk = status.sensor_ok;
    deviceFingerprint = status.config.fingerprint;
    deviceConfig = status.config;
    // Stored before anything is drawn: the tube is already spent, so the reading must be kept
    // even if rendering it fails.
    batch = await HardwareApi.recordBatchReading(batch.batch_id, role, name, m);

    const stored = role === "blank"
      ? batch.blanks[batch.blanks.length - 1]
      : batch.samples.find((s) => s.name === name).tubes.at(-1);
    renderLastTube(stored.measurement, label);
    if (stored.excluded_reason) {
      setHardwareStatus(statusEl, `${label} stored but left out: ${stored.excluded_reason}`, "error");
    } else {
      const flagText = stored.measurement.flags.length ? ` Flags: ${stored.measurement.flags.join(", ")}.` : "";
      setHardwareStatus(statusEl, `Recorded ${label}: ${formatFluorescence(stored.measurement.fluorescence)} ${HARDWARE_FLUORESCENCE_UNIT}.${flagText}`,
        stored.measurement.flags.length ? "warn" : "success");
    }
    // After the planned number of tubes, move on to the next sample.
    if (role === "sample" && sampleTubeCount(name) >= batch.tubes_per_sample) {
      let next = nextSampleId(name);
      while (sampleTubeCount(next) > 0) next = nextSampleId(next);
      document.getElementById("sample-name").value = next;
      setHardwareStatus(statusEl, `${name} done (${batch.tubes_per_sample} tubes). Next sample: ${next}.`, "success");
    }
  } catch (err) {
    console.error("Read failed:", err);
    setHardwareStatus(statusEl, `Read failed for ${label}: ${err.message}`, "error");
  } finally {
    measureReading = false;
    // A failed read says nothing about the sensor, so it leaves the buttons usable for a retry.
    if (sensorOk !== undefined) deviceSensorOk = sensorOk;
    renderBatch();
    refreshBatches();
  }
}

// ---- 4. Results -----------------------------------------------------------------

const RESULTS_COLUMN_COUNT = 8;

function renderResults() {
  const card = document.getElementById("results-card");
  if (batch.samples.length === 0) {
    setStepCard(card, "waiting", "No samples read yet.");
    return;
  }
  setStepCard(card, batch.finished_at ? "done" : "current");

  const tbody = document.getElementById("results-table-body");
  tbody.innerHTML = "";
  for (const sample of batch.samples) {
    const e = sample.estimate;
    const counted = sample.tubes.filter((tube) => tube.excluded_reason === null);
    const flags = [...new Set(counted.flatMap((tube) => tube.measurement.flags))];
    const qc = hwEl("td");
    qc.appendChild(renderFlagChips(flags));

    const open = openSamples.has(sample.name);
    const toggle = hwEl("button", "btn-secondary table-button", open ? "Hide tubes" : "Tubes");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.addEventListener("click", () => {
      if (open) openSamples.delete(sample.name);
      else openSamples.add(sample.name);
      renderResults();
    });
    const actions = hwEl("td", "action-cell");
    actions.appendChild(toggle);

    const cv = e.sd_signal !== null && e.mean_signal ? formatPercent(e.sd_signal / Math.abs(e.mean_signal)) : "--";
    const tubesText = counted.length === sample.tubes.length ? String(counted.length) : `${counted.length} of ${sample.tubes.length}`;
    const short = counted.length < batch.tubes_per_sample ? " (fewer than planned)" : "";

    const row = hwEl("tr");
    row.append(
      hwEl("td", null, sample.name),
      hwEl("td", null, `${tubesText}${short}`),
      hwEl("td", null, e.mean_signal === null ? "--" : `${formatFluorescence(e.mean_signal)} ± ${formatFluorescence(e.sd_signal)}`),
      hwEl("td", null, cv),
      hwEl("td", null, formatEstimate(e, batch.curve)),
      hwEl("td", null, e.status === "ok" ? formatConcentrationInterval(e.ci95_nM) : "--"),
      qc,
      actions,
    );
    tbody.appendChild(row);

    if (open) {
      const detail = hwEl("tr", "detail-row");
      const cell = hwEl("td");
      cell.colSpan = RESULTS_COLUMN_COUNT;
      const wrapper = hwEl("div", "table-wrapper");
      const table = hwEl("table");
      const head = hwEl("tr");
      for (const text of ["Tube", "Read at", "Signal", "Scatter", "QC", "Counted"]) head.appendChild(Object.assign(hwEl("th", null, text), { scope: "col" }));
      const thead = hwEl("thead");
      thead.appendChild(head);
      const body = hwEl("tbody");
      for (const tube of sample.tubes) {
        const m = tube.measurement;
        const tubeQc = hwEl("td");
        tubeQc.appendChild(renderFlagChips(m.flags));
        const tr = hwEl("tr");
        tr.classList.toggle("is-excluded", tube.excluded_reason !== null);
        tr.append(
          hwEl("td", null, m.sample_id),
          hwEl("td", null, formatLocalTime(m.timestamp_utc)),
          hwEl("td", null, formatFluorescence(m.fluorescence)),
          hwEl("td", null, formatFluorescence(m.scatter)),
          tubeQc,
          tubeCountedCell(tube),
        );
        body.appendChild(tr);
      }
      table.append(thead, body);
      wrapper.appendChild(table);
      cell.appendChild(wrapper);
      detail.appendChild(cell);
      tbody.appendChild(detail);
    }
  }

  const finish = document.getElementById("batch-finish-button");
  if (batch.finished_at) finishConfirming = false;
  finish.hidden = Boolean(batch.finished_at) || finishConfirming;
  document.getElementById("batch-finish-confirm").hidden = !finishConfirming;
  setBlocked(finish, document.getElementById("batch-finish-reason"), measureReading ? "A read is in progress." : null);
  document.getElementById("batch-finish-confirm-button").disabled = measureReading;
}

// One row per tube, with its group's estimate beside it: everything needed to read the result back
// without this browser. Full precision on purpose: the file is the record, the table is the view.
const BATCH_CSV_HEADERS = [
  "batch_id", "curve_id", "sensor", "curve_signal", "curve_config_fingerprint",
  "curve_lod_nM", "curve_range_min_nM", "curve_range_max_nM",
  "role", "sample_name", "tube_id", "timestamp_utc", "signal", "fluorescence", "fluorescence_sd", "scatter",
  "flags", "config_fingerprint", "excluded_reason",
  "group_n", "group_mean_signal", "group_sd_signal", "estimate_status", "inferred_nM", "ci95_low_nM", "ci95_high_nM",
  ...HARDWARE_CHANNELS.map(({ key }) => key),
];

function batchCsvRows(b) {
  const { curve } = b;
  const rows = [];
  const add = (role, name, tube, e) => {
    const m = tube.measurement;
    const raw = m.raw ?? {};
    rows.push([
      b.batch_id, curve.curve_id, curve.conditions.sensor, curve.signal, curve.config_fingerprint,
      curve.lod_nM, curve.range_nM.min, curve.range_nM.max,
      role, name, m.sample_id, m.timestamp_utc, m.signal, m.fluorescence, m.fluorescence_sd, m.scatter,
      m.flags.join(";"), m.config_fingerprint, tube.excluded_reason,
      e.n, e.mean_signal, e.sd_signal, e.status, e.concentration_nM, e.ci95_nM?.[0] ?? null, e.ci95_nM?.[1] ?? null,
      ...HARDWARE_CHANNELS.map(({ key }) => raw[key] ?? null),
    ]);
  };
  for (const tube of b.blanks) add("blank", null, tube, b.blank_estimate);
  for (const sample of b.samples) for (const tube of sample.tubes) add("sample", sample.name, tube, sample.estimate);
  return rows;
}

async function exportBatchCsv(batchId, button, statusEl) {
  button.disabled = true;
  try {
    const exported = await HardwareApi.getBatch(batchId);
    hwDownloadCsv(`lasreader-${batchId}-${hwFileStamp()}.csv`, BATCH_CSV_HEADERS, batchCsvRows(exported));
    // Only marked once the file has actually been handed to the browser.
    await HardwareApi.markBatchesExported([batchId]);
    if (batch && batch.batch_id === batchId) {
      batch = await HardwareApi.getBatch(batchId);
      renderBatch();
    }
    setHardwareStatus(statusEl, `Exported ${batchId}. Check that the download completed before relying on it.`, "success");
  } catch (err) {
    console.error("Batch export failed:", err);
    setHardwareStatus(statusEl, `Export failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
    refreshBatches();
  }
}

// Finishing can't be undone: the first press only opens the panel that says so.
function setFinishConfirming(open) {
  finishConfirming = open;
  renderResults();
  document.getElementById(open ? "batch-finish-confirm-button" : "batch-finish-button").focus();
}

async function finishBatch() {
  const statusEl = document.getElementById("results-status");
  finishConfirming = false;
  try {
    batch = await HardwareApi.finishBatch(batch.batch_id);
    setHardwareStatus(statusEl, `${batch.batch_id} finished.`, "success");
  } catch (err) {
    console.error("Could not finish the batch:", err);
    setHardwareStatus(statusEl, `Couldn't finish: ${err.message}`, "error");
  }
  renderBatch();
  refreshBatches();
}

// ---- 5. Export ------------------------------------------------------------------

// Done once the finished batch has been exported, and current again if a tube changes after that
// (the store clears exported_at). Any batch can still be exported from the Batches list at any time.
function renderExport() {
  const card = document.getElementById("export-card");
  if (!batch.finished_at) {
    setStepCard(card, "waiting", "Finish the batch first.");
    return;
  }
  setStepCard(card, batch.exported_at ? "done" : "current");
  document.getElementById("export-state").textContent = batch.exported_at
    ? `Exported ${formatLocalTime(batch.exported_at)}.`
    : "Not exported yet.";
}

// ---- The open batch -------------------------------------------------------------

function renderBatch() {
  if (!batch) return;
  renderBatchSummary();
  setStepCard(document.getElementById("curve-card"), "done");
  renderBlank();
  renderSamples();
  renderResults();
  renderExport();
}

async function openBatch(batchId, alreadyLoaded) {
  const [batchResult, statusResult] = await Promise.allSettled([
    alreadyLoaded ? Promise.resolve(alreadyLoaded) : HardwareApi.getBatch(batchId),
    HardwareApi.getDeviceStatus(),
  ]);
  if (batchResult.status === "rejected") {
    console.error("Failed to load batch:", batchResult.reason);
    history.replaceState(null, "", "hardware-measure.html");
    await showChooser();
    setHardwareStatus(document.getElementById("batch-start-status"), `Couldn't load ${batchId}: ${batchResult.reason.message}`, "error");
    return;
  }
  batch = batchResult.value;
  deviceFingerprint = statusResult.status === "fulfilled" ? statusResult.value.config.fingerprint : null;
  deviceSensorOk = statusResult.status === "fulfilled" ? statusResult.value.sensor_ok : null;
  deviceConfig = statusResult.status === "fulfilled" ? statusResult.value.config : null;
  hardwareRemember(HARDWARE_LAST_BATCH_KEY, batch.batch_id);

  // Resume on the first sample that still needs tubes, or the one after the last.
  const unfinished = batch.samples.find((s) => s.tubes.length < batch.tubes_per_sample);
  const last = batch.samples.at(-1);
  if (unfinished) document.getElementById("sample-name").value = unfinished.name;
  else if (last) {
    let next = nextSampleId(last.name);
    while (sampleTubeCount(next) > 0) next = nextSampleId(next);
    document.getElementById("sample-name").value = next;
  }

  document.getElementById("batch-form").hidden = true;
  document.getElementById("batch-summary").hidden = false;
  renderBatch();
}

// ---- Batch list --------------------------------------------------------------------

async function refreshBatches() {
  const statusEl = document.getElementById("batches-status");
  let batches;
  try {
    batches = await HardwareApi.listBatches();
    setHardwareStatus(statusEl, "", null);
  } catch (err) {
    console.error("Could not load batches:", err);
    setHardwareStatus(statusEl, `Couldn't load batches: ${err.message}`, "error");
    return;
  }
  document.getElementById("batches-empty").hidden = batches.length > 0;
  document.getElementById("batches-table-wrapper").hidden = batches.length === 0;
  const tbody = document.getElementById("batches-table-body");
  tbody.innerHTML = "";
  for (const summary of batches) {
    const csv = hwEl("button", "btn-secondary table-button", "CSV");
    csv.type = "button";
    csv.setAttribute("aria-label", `Export batch ${summary.batch_id} as CSV`);
    csv.addEventListener("click", () => exportBatchCsv(summary.batch_id, csv, statusEl));
    const actions = hwEl("td", "action-cell");
    actions.append(hwLink(`hardware-measure.html?batch=${encodeURIComponent(summary.batch_id)}`, "Open"), " ", csv);

    const exported = hwEl("td");
    if (summary.exported_at) exported.textContent = formatLocalTime(summary.exported_at);
    else exported.appendChild(hwEl("span", "flag-chip warn", "Not yet"));

    const row = hwEl("tr");
    if (batch && batch.batch_id === summary.batch_id) row.classList.add("is-target");
    row.append(
      hwEl("td", null, summary.batch_id),
      hwEl("td", null, formatLocalTime(summary.created_at)),
      hwEl("td", null, formatConditions(summary.conditions)),
      hwEl("td", null, summary.curve_id),
      hwEl("td", null, String(summary.samples)),
      hwEl("td", null, summary.finished_at ? "Finished" : "Open"),
      exported,
      actions,
    );
    tbody.appendChild(row);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("batch-form");
  form.addEventListener("submit", startBatch);
  form.addEventListener("change", updateBatchStartControls);
  form.addEventListener("input", updateBatchStartControls);

  document.getElementById("blank-read-button").addEventListener("click", () => readTube("blank"));
  document.getElementById("sample-read-button").addEventListener("click", () => readTube("sample"));
  document.getElementById("sample-name").addEventListener("input", () => { if (batch) renderSamples(); });
  document.getElementById("sample-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      document.getElementById("sample-read-button").click();
    }
  });
  document.getElementById("results-export-button").addEventListener("click", (event) =>
    exportBatchCsv(batch.batch_id, event.currentTarget, document.getElementById("export-status")));
  document.getElementById("batch-finish-button").addEventListener("click", () => setFinishConfirming(true));
  document.getElementById("batch-finish-confirm-button").addEventListener("click", finishBatch);
  document.getElementById("batch-finish-cancel-button").addEventListener("click", () => setFinishConfirming(false));

  refreshBatches();
  setInterval(refreshDevice, DEVICE_STATUS_POLL_INTERVAL_MS);
  const batchId = hardwareQueryParam("batch");
  if (batchId) openBatch(batchId);
  else showChooser();
});
