// =========================================================
// Backs hardware.html: the CAPTURE-Screen instrument status page (the hardware section's home).
// Target elements:
//   #status-load / #status-body / #status-connection / #status-heartbeat
//   #status-fingerprint / #status-curve-count / #status-dark-alert / #status-config-body
//   #status-active-curve
//   #dark-read-button / #blank-read-button / #check-reason / #check-status / #check-result
// Backing API (js/hardware_api.js): getDeviceStatus / listCurves / getActiveCurve /
//   runDarkRead / readSample
// =========================================================

// Prompt to redo a dark read after this long: ambient light and temperature both drift the dark level.
const DARK_READ_STALE_MINUTES = 60;
// Subtracting two dark reads should give 0 on every channel; this is how much read noise is
// tolerated, in "raw" ADC counts converted to basic counts using the device's gain / ATIME / ASTEP.
const DARK_READ_TOLERANCE_COUNTS = 2;
const DARK_READ_ALERT_REFRESH_MS = 30000;

// Both checks are blocked by the same thing, so they share one reason element. sensorReading()
// is in hardware_common.js: Measure and Calibration block their reads on the same rule.
function applySensorBlock(sensorOk) {
  const { blocks } = sensorReading(sensorOk);
  setBlocked(document.getElementById("dark-read-button"), document.getElementById("check-reason"), blocks);
  setBlocked(document.getElementById("blank-read-button"), null, blocks);
}

function formatUptime(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

async function loadInstrumentStatus() {
  const loadEl = document.getElementById("status-load");
  const [statusResult, curvesResult, activeResult] = await Promise.allSettled([
    HardwareApi.getDeviceStatus(),
    HardwareApi.listCurves(),
    HardwareApi.getActiveCurve(),
  ]);
  const config = statusResult.status === "fulfilled" ? statusResult.value.config : null;

  // Curves live in the browser, so they still show even when the device is unreachable.
  if (activeResult.status === "fulfilled") {
    renderActiveCurveSummary(activeResult.value, config);
  } else {
    setHardwareStatus(document.getElementById("status-active-curve"),
      `Could not load the active curve: ${activeResult.reason.message}`, "error");
  }

  if (statusResult.status === "rejected") {
    console.error("Failed to load instrument status:", statusResult.reason);
    setHardwareStatus(loadEl, `Could not reach the instrument: ${statusResult.reason.message}`, "error");
    return;
  }

  renderInstrument(statusResult.value, curvesResult.status === "fulfilled" ? curvesResult.value : null);
  applySensorBlock(statusResult.value.sensor_ok);
  loadEl.hidden = true;
  document.getElementById("status-body").hidden = false;
}

function renderInstrument(status, curves) {
  const { config } = status;

  const sensor = sensorReading(status.sensor_ok);
  const connection = document.getElementById("status-connection");
  // A device whose sensor is dead is still connected, but calling that plain "Online" would
  // read as ready to measure, which it isn't.
  connection.textContent = status.online ? (sensor.tone === "error" ? "Online · sensor offline" : "Online") : "Offline";
  connection.classList.toggle("is-error", !status.online || sensor.tone === "error");
  document.getElementById("status-heartbeat").textContent =
    `Last heartbeat ${formatLocalTime(status.last_seen)} (${formatAgo(status.last_seen)})`;

  document.getElementById("status-fingerprint").textContent = config.fingerprint;
  document.getElementById("status-curve-count").textContent = curves
    ? `Curves matching this config: ${curves.filter((curve) => curve.config_fingerprint === config.fingerprint).length}`
    : "Curves matching this config: unavailable";

  const tbody = document.getElementById("status-config-body");
  tbody.innerHTML = "";
  appendKvRow(tbody, "Device", `${status.device_id} · ${status.state}`);
  appendKvRow(tbody, "AS7341 sensor", sensor.text);
  appendKvRow(tbody, "Wi-Fi signal", `${status.wifi_rssi} dBm`);
  appendKvRow(tbody, "Uptime", formatUptime(status.uptime_ms));
  appendKvRow(tbody, "LED current", `${config.led_current_mA} mA`);
  appendKvRow(tbody, "Gain", `${config.gain}×`);
  appendKvRow(tbody, "ATIME / ASTEP", `${config.atime} / ${config.astep}`);
  appendKvRow(tbody, "Integration time", `${HardwareProcessing.integrationTimeMs(config).toFixed(2)} ms`);
  appendKvRow(tbody, "Build ID", config.build_id);
  appendKvRow(tbody, "Firmware version", config.firmware_version);
  appendKvRow(tbody, "Emission filter", config.emission_filter ?? "Not selected yet");

  renderDarkReadAlert();
}

function renderDarkReadAlert() {
  const el = document.getElementById("status-dark-alert");
  const last = hardwareRecall(HARDWARE_LAST_DARK_READ_KEY);
  if (!last) {
    setHardwareStatus(el, "No dark read on record in this browser. Run a dark read before measuring.", "warn");
    return;
  }
  const minutes = (Date.now() - Date.parse(last)) / 60000;
  const text = `Last dark read: ${formatAgo(last)} (${formatLocalTime(last)}).`;
  if (minutes > DARK_READ_STALE_MINUTES) {
    setHardwareStatus(el, `${text} That is over ${DARK_READ_STALE_MINUTES} min old, so run a new one.`, "warn");
  } else {
    setHardwareStatus(el, text, "success");
  }
}

// config being null means the device is unreachable, so there's no way to tell if the curve still applies.
function renderActiveCurveSummary(curve, config) {
  const container = document.getElementById("status-active-curve");
  container.innerHTML = "";

  if (!curve) {
    const empty = hwEl("div", "empty-state");
    empty.appendChild(hwEl("p", null,
      "No active calibration curve. Readings cannot be converted to concentration until a curve is fitted and set as active."));
    empty.appendChild(hwLink("hardware-calibration.html", "Run a calibration →"));
    container.appendChild(empty);
    return;
  }

  const stale = config ? curve.config_fingerprint !== config.fingerprint : false;

  const heading = hwEl("div", "curve-summary-heading");
  heading.append(
    hwEl("strong", null, curve.curve_id),
    hwEl("span", `flag-chip ${stale ? "error" : config ? "ok" : ""}`.trim(), stale ? "stale" : config ? "active" : "active (unverified)"),
  );

  const meta = hwEl("p", "plan-meta");
  meta.append(`Fitted ${formatLocalTime(curve.fitted_at)} · ${curve.timepoint} · config `, hwFingerprint(curve.config_fingerprint));
  if (curve.source === "manual") meta.append(" · manual entry");

  const stats = hwEl("div", "sensor-stats");
  stats.append(
    hwStatTile("EC50", formatConcentration(curve.params.ec50_nM)),
    hwStatTile("Hill slope", curve.params.hill.toFixed(2)),
    hwStatTile("LOD", formatConcentration(curve.lod_nM), `LOQ ${formatConcentration(curve.loq_nM)}`),
    hwStatTile("Usable range", formatConcentrationInterval([curve.range_nM.min, curve.range_nM.max])),
  );

  container.append(heading, meta, stats);

  if (stale) {
    const warning = hwEl("p", "status-message error");
    warning.append("The instrument configuration changed after this curve was fitted, so it does not apply. ",
      hwLink("hardware-calibration.html", "Rebuild the curve →"));
    container.appendChild(warning);
  } else if (!config) {
    container.appendChild(hwEl("p", "status-message warn",
      "The instrument is unreachable, so it can't be checked whether this curve still matches its config."));
  }

  const more = hwEl("p", "link-row");
  more.appendChild(hwLink("hardware-curves.html", "All curves →"));
  container.appendChild(more);
}

async function runInstrumentCheck(kind) {
  const buttons = [document.getElementById("dark-read-button"), document.getElementById("blank-read-button")];
  const statusEl = document.getElementById("check-status");
  const result = document.getElementById("check-result");
  const name = kind === "dark" ? "Dark read" : "Blank read";

  let sensorOk;
  buttons.forEach((button) => { button.disabled = true; });
  result.hidden = true;
  setHardwareStatus(statusEl, kind === "dark" ? "Running dark read..." : "Reading blank...", null);

  try {
    const [m, status] = await Promise.all([
      kind === "dark"
        ? HardwareApi.runDarkRead()
        : HardwareApi.readSample({ sample_id: `BLANK-CHECK-${Date.now()}`, sample_type: "blank" }),
      HardwareApi.getDeviceStatus(),
    ]);
    sensorOk = status.sensor_ok;

    result.innerHTML = "";
    result.hidden = false;

    if (kind === "dark") {
      hardwareRemember(HARDWARE_LAST_DARK_READ_KEY, m.timestamp_utc);
      renderDarkReadAlert();
      renderDarkResult(m, status.config, result, statusEl);
    } else {
      renderBlankResult(m, result, statusEl);
    }
  } catch (err) {
    console.error(`${name} failed:`, err);
    setHardwareStatus(statusEl, `${name} failed: ${err.message}`, "error");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    // The status fetched alongside the read may have changed the answer. A failed check tells
    // us nothing about the sensor, so it leaves the buttons usable for a retry.
    if (sensorOk !== undefined) applySensorBlock(sensorOk);
  }
}

// A dark read's raw value is dark_2 - dark_1 (basic counts, sign preserved).
function renderDarkResult(m, config, container, statusEl) {
  const heading = hwEl("h3", "subsection-heading", `Dark read (dark_2 − dark_1) · ${formatLocalTime(m.timestamp_utc)}`);

  if (m.flags.includes("NO_DARK_PAIR")) {
    setHardwareStatus(statusEl, "Dark read incomplete: the device returned only one dark frame, so there is nothing to compare.", "error");
    container.append(heading, renderFlagChips(m.flags));
    return;
  }

  const tolerance = HardwareProcessing.countsToBasic(DARK_READ_TOLERANCE_COUNTS, config);
  const worst = HARDWARE_CHANNELS.reduce((acc, ch) => (Math.abs(m.raw[ch.key]) > Math.abs(m.raw[acc.key]) ? ch : acc));
  const worstValue = m.raw[worst.key];

  if (Math.abs(worstValue) <= tolerance) {
    setHardwareStatus(statusEl,
      `Dark read normal: every channel is within ±${formatFluorescence(tolerance)} ${HARDWARE_FLUORESCENCE_UNIT} (${DARK_READ_TOLERANCE_COUNTS} raw counts) of 0.`,
      "success");
  } else {
    setHardwareStatus(statusEl,
      `Dark read abnormal: channel ${worst.axis} changed by ${formatSignedFluorescence(worstValue)} ${HARDWARE_FLUORESCENCE_UNIT} between the two dark frames. Check for light leaks.`,
      "error");
  }

  container.append(heading, renderChannelTable(m.raw));
}

function renderBlankResult(m, container, statusEl) {
  setHardwareStatus(statusEl, `Blank read at ${formatLocalTime(m.timestamp_utc)}.`, m.flags.length ? "warn" : "success");

  const signal = hwStatTile("sfGFP signal · F4 515 nm",
    `${formatFluorescence(m.fluorescence)} ± ${formatFluorescence(m.fluorescence_sd)}`, HARDWARE_FLUORESCENCE_UNIT);
  signal.appendChild(hwBasisNote());

  const stats = hwEl("div", "sensor-stats");
  stats.append(signal, hwStatTile("Scatter · F3 480 nm", formatFluorescence(m.scatter), HARDWARE_FLUORESCENCE_UNIT));

  container.append(
    hwEl("h3", "subsection-heading", `Blank read · ${formatLocalTime(m.timestamp_utc)}`),
    stats,
    renderFlagChips(m.flags),
    renderChannelTable(m.raw),
  );
  fillBasisNotes(container);
}

document.addEventListener("DOMContentLoaded", () => {
  loadInstrumentStatus();
  setInterval(renderDarkReadAlert, DARK_READ_ALERT_REFRESH_MS);
  document.getElementById("dark-read-button").addEventListener("click", () => runInstrumentCheck("dark"));
  document.getElementById("blank-read-button").addEventListener("click", () => runInstrumentCheck("blank"));
});
