// =========================================================
// Backs hardware-measure.html: measures one sample tube, showing the sfGFP signal, the
// inferred AHL concentration, QC flags, a ten-channel bar chart, and config provenance.
// Target elements:
//   #measure-curve (the curve currently in use, top right)
//   #measure-form / #measure-sample-id / #measure-sample-type
//   #measure-known-field / #measure-known-concentration / #measure-read-button
//   #measure-status / #measure-result / #measure-signal(-sub)
//   #measure-concentration(-sub) / #measure-flags / #measure-channel-chart / #measure-provenance
//   #log-count / #log-export-button(-reason) / #log-status / #log-empty
//   #log-table-wrapper / #log-table-body
// Backing API: getActiveCurve / getDeviceStatus / readSample / invert /
//   recordMeasurement / listMeasurements / markMeasurementsExported
//
// The inverse estimate only shows a numeric concentration when status === "ok". Every other
// status gets no point estimate at all, and nothing is ever extrapolated outside the curve's range.
//
// Every reading is appended to the browser-local log before it is drawn, so a rendering fault
// can't cost a tube. The log is the working copy; the CSV export is the one that survives a
// cleared browser, which is why the unexported count sits in front of the user at all times.
// =========================================================

let channelChart = null;

// Picking a sample type does more than label the row, and only Blank's effect outlives the
// reading: it becomes the scatter baseline every later tube under this config is judged against.
// Unknown and Standard change only how this one reading is treated, which the page already shows
// (the known-concentration field, the QC flags), so neither needs a note here.
const SAMPLE_TYPE_NOTE = {
  blank: "Sets the scatter baseline for this instrument config: later readings above twice this tube's scatter are flagged HIGH_SCATTER.",
};

// Draws a text label above the F4 / F3 bars. Chart.js has no built-in annotation support,
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

function renderCurveChip(curve, config) {
  const el = document.getElementById("measure-curve");
  el.innerHTML = "";
  el.appendChild(hwEl("span", "curve-chip-label", "Curve in use"));

  if (!curve) {
    el.append(hwEl("strong", null, "No active curve"), hwLink("hardware-calibration.html", "Run a calibration →"));
    return;
  }

  const stale = config && curve.config_fingerprint !== config.fingerprint;
  const bound = hwEl("span");
  bound.append("Config ", hwFingerprint(curve.config_fingerprint));
  if (stale) bound.append(" ", hwEl("span", "flag-chip error", "stale"));

  el.append(
    hwEl("strong", null, curve.curve_id),
    hwEl("span", null, `Fitted ${formatLocalTime(curve.fitted_at)}${curve.source === "manual" ? " · manual entry" : ""}`),
    // The curve only applies to a sample grown to the same timepoint, so it belongs next to the
    // config the curve is bound to, not only on the Curves page.
    hwEl("span", null, `Timepoint ${curve.timepoint}`),
    bound,
  );
}

// Blocked with a reason rather than left to fail: without the AS7341 every read comes back
// sensor_offline. An unreachable device leaves sensor_ok unknown, which blocks nothing.
function applySensorBlock(sensorOk) {
  setBlocked(document.getElementById("measure-read-button"),
    document.getElementById("measure-read-reason"), sensorReading(sensorOk).blocks);
}

// The curve itself should still show when the device is unreachable, just without a stale check.
async function refreshCurveChip() {
  const [curveResult, statusResult] = await Promise.allSettled([
    HardwareApi.getActiveCurve(),
    HardwareApi.getDeviceStatus(),
  ]);
  // Before the curve: whether reading is possible doesn't depend on there being a curve.
  applySensorBlock(statusResult.status === "fulfilled" ? statusResult.value.sensor_ok : null);
  if (curveResult.status === "rejected") {
    document.getElementById("measure-curve").textContent = `Curve unavailable: ${curveResult.reason.message}`;
    return;
  }
  renderCurveChip(curveResult.value, statusResult.status === "fulfilled" ? statusResult.value.config : null);
}

// Recovery = inferred / known: the one number that says whether the curve still reads true on a
// tube whose answer is already known. Needs a point estimate, so only status "ok" qualifies, and a
// 0 nM standard has nothing to divide by.
function recoveryPercent(measurement, estimate) {
  if (measurement.sample_type !== "standard" || estimate.status !== "ok") return null;
  if (!(measurement.known_concentration_nM > 0)) return null;
  return formatPercent(estimate.concentration_nM / measurement.known_concentration_nM);
}

function renderEstimate(estimate, curve, measurement) {
  const value = document.getElementById("measure-concentration");
  const sub = document.getElementById("measure-concentration-sub");
  value.classList.remove("is-message");
  sub.innerHTML = "";
  document.getElementById("measure-known-sub")?.remove();

  switch (estimate.status) {
    case "ok":
      value.textContent = formatConcentration(estimate.concentration_nM);
      sub.textContent = `95% CI ${formatConcentrationInterval(estimate.ci95_nM)} · curve ${estimate.curve_id}`;
      break;
    case "below_lod":
      // range_nM.min = max(LOD, lowest standard), which usually just equals the LOD.
      value.textContent = curve ? `< ${formatConcentration(curve.range_nM.min)}` : "< LOD";
      sub.textContent = curve
        ? `Below the curve's lower limit (LOD ${formatConcentration(curve.lod_nM)}). No point estimate.`
        : "Below LOD. No point estimate.";
      break;
    case "above_range":
      value.textContent = curve ? `> ${formatConcentration(curve.range_nM.max)}` : "> range";
      sub.textContent = "Above the calibrated range. No point estimate; dilute and read again.";
      break;
    case "no_curve":
      value.textContent = "No active curve";
      value.classList.add("is-message");
      sub.appendChild(hwLink("hardware-calibration.html", "Run a calibration →"));
      break;
    case "config_mismatch":
      value.textContent = "Instrument config changed, curve not applicable";
      value.classList.add("is-message");
      sub.appendChild(hwLink("hardware-calibration.html", "Rebuild the curve →"));
      break;
    default:
      value.textContent = "--";
  }

  if (measurement.sample_type === "standard") {
    const recovery = recoveryPercent(measurement, estimate);
    const known = hwEl("span", "sensor-stat-sub",
      `Known: ${formatConcentration(measurement.known_concentration_nM)}${recovery ? ` · recovery ${recovery}` : ""}`);
    known.id = "measure-known-sub";
    sub.after(known);
  }
}

function renderChannelChart(raw) {
  const canvas = document.getElementById("measure-channel-chart");
  if (channelChart) channelChart.destroy();

  const accent = cssVar("--accent");
  const gold = cssVar("--gold");
  const goldInk = cssVar("--gold-ink");
  const muted = cssVar("--muted");
  const ink = cssVar("--text");
  const rule = cssVar("--border");

  const colors = HARDWARE_CHANNELS.map(({ key }) => {
    if (key === "F4") return accent;
    if (key === "F3") return gold;
    return muted;
  });

  channelChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: HARDWARE_CHANNELS.map((channel) => channel.axis),
      datasets: [{
        label: "Basic counts",
        data: HARDWARE_CHANNELS.map(({ key }) => raw[key]),
        backgroundColor: colors,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      aspectRatio: 2.6,
      animation: false,
      layout: { padding: { top: 8 } },
      scales: {
        x: {
          title: { display: true, text: "Channel center wavelength (nm)", color: ink },
          grid: { display: false },
          ticks: { color: muted },
        },
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
        channelAnnotations: {
          annotations: {
            F4: { text: "sfGFP 510 nm", color: accent },
            F3: { text: "leakage", color: goldInk },
          },
        },
      },
    },
    plugins: [channelAnnotationPlugin],
  });
}

function renderProvenance(m, config) {
  const el = document.getElementById("measure-provenance");
  el.innerHTML = "";

  const item = (label, value) => {
    const span = hwEl("span");
    span.append(hwEl("b", null, `${label} `), value);
    el.appendChild(span);
  };

  // The current config details only describe this reading if the config hasn't changed; otherwise all that can be shown is the fingerprint.
  if (config && config.fingerprint === m.config_fingerprint) {
    item("LED", `${config.led_current_mA} mA`);
    item("Gain", `${config.gain}×`);
    item("ATIME / ASTEP", `${config.atime} / ${config.astep}`);
    item("Build", config.build_id);
    item("Firmware", config.firmware_version);
  } else {
    item("Config details", "unavailable (the instrument config changed after this read)");
  }
  item("Config", hwFingerprint(m.config_fingerprint));
}

function nextSampleId(id) {
  const match = id.match(/^(.*?)(\d+)$/);
  if (!match) return id;
  return match[1] + String(Number(match[2]) + 1).padStart(match[2].length, "0");
}

// ---- Reading log ---------------------------------------------------------

const LOG_TYPE_LABEL = { unknown: "Unknown", standard: "Standard", blank: "Blank" };

// One row per reading, holding everything needed to read it back without this browser: the
// signal, the estimate as reported, the curve's limits at the time, and every raw channel.
const LOG_CSV_HEADERS = [
  "record_id", "sample_id", "timestamp_utc", "sample_type", "known_concentration_nM",
  "fluorescence", "fluorescence_sd", "scatter",
  "estimate_status", "inferred_nM", "ci95_low_nM", "ci95_high_nM",
  "curve_id", "curve_timepoint", "curve_lod_nM", "curve_range_min_nM", "curve_range_max_nM",
  "flags", "config_fingerprint", "source",
  ...HARDWARE_CHANNELS.map(({ key }) => key),
];

// Same rule as the result card: a number only for "ok", and never an extrapolation.
function logEstimateText(record) {
  const { estimate, curve } = record;
  switch (estimate.status) {
    case "ok": return formatConcentration(estimate.concentration_nM);
    case "below_lod": return curve ? `< ${formatConcentration(curve.range_nM.min)}` : "< LOD";
    case "above_range": return curve ? `> ${formatConcentration(curve.range_nM.max)}` : "> range";
    case "no_curve": return "No curve";
    case "config_mismatch": return "Config changed";
    default: return "--";
  }
}

// Full precision on purpose: the file is the record, the table is the view.
function logCsvRow(record) {
  const { measurement: m, estimate, curve } = record;
  const raw = m.raw ?? {};
  return [
    record.record_id, m.sample_id, m.timestamp_utc, m.sample_type, m.known_concentration_nM,
    m.fluorescence, m.fluorescence_sd, m.scatter,
    estimate.status, estimate.concentration_nM,
    estimate.ci95_nM?.[0] ?? null, estimate.ci95_nM?.[1] ?? null,
    estimate.curve_id, curve?.timepoint ?? null, curve?.lod_nM ?? null,
    curve?.range_nM.min ?? null, curve?.range_nM.max ?? null,
    m.flags.join(";"), m.config_fingerprint, m.source,
    ...HARDWARE_CHANNELS.map(({ key }) => raw[key] ?? null),
  ];
}

function renderLog(records) {
  const unexported = records.filter((record) => !record.exported_at).length;

  const chip = document.getElementById("log-count");
  chip.textContent = records.length === 0
    ? "Empty"
    : `${records.length} reading${records.length === 1 ? "" : "s"} · ${unexported} not exported`;
  chip.className = `flag-chip ${unexported > 0 ? "warn" : records.length > 0 ? "ok" : ""}`.trim();

  setBlocked(document.getElementById("log-export-button"), document.getElementById("log-export-reason"),
    records.length === 0 ? "No readings to export yet." : null);

  document.getElementById("log-empty").hidden = records.length > 0;
  document.getElementById("log-table-wrapper").hidden = records.length === 0;

  const tbody = document.getElementById("log-table-body");
  tbody.innerHTML = "";
  // Newest first: the tube just read is the one being looked at.
  for (const record of [...records].reverse()) {
    const m = record.measurement;
    const qc = hwEl("td");
    qc.appendChild(renderFlagChips(m.flags));

    const type = m.sample_type === "standard"
      ? `Standard (${formatConcentration(m.known_concentration_nM)})`
      : LOG_TYPE_LABEL[m.sample_type] ?? m.sample_type;

    // Recovery belongs in the table too: checking the curve usually means reading several
    // standards and comparing them, not looking at one result card.
    const inferred = hwEl("td", null, logEstimateText(record));
    const recovery = recoveryPercent(m, record.estimate);
    if (recovery) inferred.append(" ", hwEl("span", "cell-note", recovery));

    const row = hwEl("tr");
    row.append(
      hwEl("td", null, formatLocalTime(m.timestamp_utc)),
      hwEl("td", null, m.sample_id),
      hwEl("td", null, type),
      hwEl("td", null, formatFluorescence(m.fluorescence)),
      inferred,
      hwEl("td", null, record.estimate.curve_id ?? "--"),
      qc,
      hwEl("td", null, record.exported_at ? formatLocalTime(record.exported_at) : "Not yet"),
    );
    tbody.appendChild(row);
  }
}

async function refreshLog() {
  try {
    renderLog(await HardwareApi.listMeasurements());
  } catch (err) {
    console.error("Could not load the reading log:", err);
    setHardwareStatus(document.getElementById("log-status"), `Could not load the log: ${err.message}`, "error");
  }
}

async function exportLog() {
  const button = document.getElementById("log-export-button");
  const statusEl = document.getElementById("log-status");
  if (button.disabled) return;

  button.disabled = true;
  try {
    // Everything every time: overlapping files are cheap, a missing reading is not.
    const records = await HardwareApi.listMeasurements();
    if (records.length === 0) {
      setHardwareStatus(statusEl, "Nothing to export yet.", "warn");
      return;
    }
    hwDownloadCsv(`lasreader-measurements-${hwFileStamp()}.csv`, LOG_CSV_HEADERS, records.map(logCsvRow));
    // Only marked once the file has actually been handed to the browser: if anything above threw,
    // every reading must stay counted as unexported.
    await HardwareApi.markMeasurementsExported(records.map((record) => record.record_id));
    setHardwareStatus(statusEl,
      `Exported ${records.length} reading${records.length === 1 ? "" : "s"}. Check the download completed before relying on it.`,
      "success");
    await refreshLog();
  } catch (err) {
    console.error("Export failed:", err);
    setHardwareStatus(statusEl, `Export failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function readMeasureSample(event) {
  event.preventDefault();

  const idInput = document.getElementById("measure-sample-id");
  const sampleType = document.getElementById("measure-sample-type").value;
  const statusEl = document.getElementById("measure-status");
  const button = document.getElementById("measure-read-button");
  if (button.disabled) return;

  const sampleId = idInput.value.trim();
  if (!sampleId) {
    setHardwareStatus(statusEl, "Enter a sample ID first.", "error");
    return;
  }

  const input = { sample_id: sampleId, sample_type: sampleType };
  if (sampleType === "standard") {
    const knownInput = document.getElementById("measure-known-concentration");
    const known = Number(knownInput.value);
    if (knownInput.value === "" || !(known >= 0)) {
      setHardwareStatus(statusEl, "A standard needs its known concentration (nM).", "error");
      return;
    }
    input.known_concentration_nM = known;
  }

  let sensorOk;
  button.disabled = true;
  // Hide the previous tube's result first: if this read fails, the old numbers can't be left on screen looking like they belong to this one.
  document.getElementById("measure-result").hidden = true;
  setHardwareStatus(statusEl, `Reading ${sampleId}...`, null);

  try {
    const [m, status] = await Promise.all([HardwareApi.readSample(input), HardwareApi.getDeviceStatus()]);
    sensorOk = status.sensor_ok;
    const [estimate, curve] = await Promise.all([
      HardwareApi.invert(m.fluorescence, m.config_fingerprint),
      HardwareApi.getActiveCurve(),
    ]);
    // The active curve could be swapped between the two calls; if they don't match, don't use its LOD / range for display.
    const matchingCurve = curve && curve.curve_id === estimate.curve_id ? curve : null;

    // Recorded before anything is drawn: the tube is already spent, so the reading must be kept
    // even if rendering it fails.
    await HardwareApi.recordMeasurement(m, estimate, matchingCurve);

    renderCurveChip(curve, status.config);

    document.getElementById("measure-result").hidden = false;
    document.getElementById("measure-signal").textContent =
      `${formatFluorescence(m.fluorescence)} ± ${formatFluorescence(m.fluorescence_sd)}`;
    document.getElementById("measure-signal-sub").textContent =
      `${HARDWARE_FLUORESCENCE_UNIT} (± read-noise SD from the dark frames) · scatter ${formatFluorescence(m.scatter)}`;
    renderEstimate(estimate, matchingCurve, m);

    const flags = document.getElementById("measure-flags");
    flags.innerHTML = "";
    flags.appendChild(renderFlagChips(m.flags));

    renderChannelChart(m.raw);
    renderProvenance(m, status.config);

    setHardwareStatus(statusEl, `Read ${m.sample_id} at ${formatLocalTime(m.timestamp_utc)}.`, m.flags.length ? "warn" : "success");
    idInput.value = nextSampleId(sampleId);
    await refreshLog();
  } catch (err) {
    console.error("Measurement failed:", err);
    setHardwareStatus(statusEl, `Read failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
    // A failed read says nothing about the sensor, so it leaves the button usable for a retry.
    if (sensorOk !== undefined) applySensorBlock(sensorOk);
  }
}

function applySampleType() {
  const type = document.getElementById("measure-sample-type").value;
  document.getElementById("measure-known-field").hidden = type !== "standard";

  const note = document.getElementById("measure-type-note");
  note.textContent = SAMPLE_TYPE_NOTE[type] ?? "";
  note.hidden = !note.textContent;
}

document.addEventListener("DOMContentLoaded", () => {
  refreshCurveChip();
  refreshLog();

  // Called on load as well as on change: a browser restoring the select on reload would otherwise
  // leave the page showing Unknown's fields under a different selection.
  applySampleType();
  document.getElementById("measure-sample-type").addEventListener("change", applySampleType);

  document.getElementById("measure-form").addEventListener("submit", readMeasureSample);
  document.getElementById("log-export-button").addEventListener("click", exportLog);
});
