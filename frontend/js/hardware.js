// =========================================================
// Backs hardware.html: the CAPTURE-Screen instrument status page (the hardware section's home).
// Target elements:
//   #status-load / #status-body / #status-connection / #status-heartbeat
//   #status-fingerprint / #status-curve-count / #status-dark-alert / #status-config-body
//   #status-active-curve
//   #dark-read-button / #blank-read-button / #check-reason / #check-status / #check-result
//   #backup-* family (one file holding runs, curves and readings), #reset-* family (delete all)
// Backing API (js/hardware_api.js): getDeviceStatus / listCurves / getActiveCurve /
//   runDarkRead / runBlankCheck / exportBackup / importBackup / getResetPreview / resetAll
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
      // Both checks are display-only: neither is stored, and neither touches the blank-scatter baseline.
      kind === "dark" ? HardwareApi.runDarkRead() : HardwareApi.runBlankCheck(),
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

// ---- Backup ---------------------------------------------------------------
// The whole hardware section's data in one file. Deliberately one file and not three: a curve
// means nothing without the run it was fitted from, and it took only forgetting one of two
// downloads to end up with exactly that.

const BACKUP_SECTIONS = [["run", "plans"], ["curve", "curves"], ["reading", "measurements"]];

function backupCount(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// When a backup file was last produced from this browser, or null. A stored value that isn't a
// date counts as never: this feeds a warning before a deletion, so it must not read as reassurance.
function lastBackupUtc() {
  const value = hardwareRecall(HARDWARE_LAST_BACKUP_KEY);
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function lastBackupText() {
  const last = lastBackupUtc();
  return last
    ? `Last exported ${formatLocalTime(last)} (${formatAgo(last)}).`
    : "Never exported from this browser.";
}

async function refreshBackupSummary() {
  const summaryEl = document.getElementById("backup-summary");
  try {
    const payload = await HardwareApi.exportBackup();
    const counts = BACKUP_SECTIONS.map(([word, key]) => backupCount(payload[key].length, word));
    const total = BACKUP_SECTIONS.reduce((sum, [, key]) => sum + payload[key].length, 0);
    summaryEl.textContent = `${counts.join(" · ")}. ${lastBackupText()}`;
    setBlocked(document.getElementById("backup-export-button"), document.getElementById("backup-export-reason"),
      total === 0 ? "Nothing stored in this browser yet." : null);
  } catch (err) {
    console.error("Could not read what is stored:", err);
    summaryEl.textContent = `Could not read what is stored: ${err.message}`;
  }
}

// The button and status line are parameters because two places export: the Backup card, and the
// Reset card's "Export everything first", whose result has to appear next to the button that was
// pressed rather than in a card that may be off screen.
async function exportBackup(
  button = document.getElementById("backup-export-button"),
  statusEl = document.getElementById("backup-export-status"),
) {
  if (button.disabled) return;

  button.disabled = true;
  try {
    const payload = await HardwareApi.exportBackup();
    const total = BACKUP_SECTIONS.reduce((sum, [, key]) => sum + payload[key].length, 0);
    if (total === 0) {
      setHardwareStatus(statusEl, "Nothing stored in this browser yet.", "warn");
      return;
    }
    hwDownloadJson(`lasreader-backup-${hwFileStamp()}.json`, payload);
    // The readings are in a file now, so the Measure page's unexported count has to agree.
    await HardwareApi.markMeasurementsExported(payload.measurements.map((record) => record.record_id));
    hardwareRemember(HARDWARE_LAST_BACKUP_KEY, new Date().toISOString());
    setHardwareStatus(statusEl,
      `Exported ${BACKUP_SECTIONS.map(([word, key]) => backupCount(payload[key].length, word)).join(", ")}. `
      + "Check the download completed before relying on it.", "success");
  } catch (err) {
    console.error("Backup export failed:", err);
    setHardwareStatus(statusEl, `Export failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
    // Both cards show what was last exported, so both have to catch up.
    refreshBackupSummary();
    if (!document.getElementById("reset-panel").hidden) refreshResetPanel();
  }
}

function backupImportFile() {
  return document.getElementById("backup-import-file").files?.[0] ?? null;
}

function updateBackupImportControls() {
  setBlocked(document.getElementById("backup-import-button"), document.getElementById("backup-import-reason"),
    backupImportFile() ? null : "Choose a backup file first.");
}

async function importBackup(event) {
  event.preventDefault();
  const button = document.getElementById("backup-import-button");
  const statusEl = document.getElementById("backup-import-status");
  const detail = document.getElementById("backup-import-detail");
  if (button.disabled) return;

  const file = backupImportFile();
  detail.innerHTML = "";
  detail.hidden = true;
  button.disabled = true;
  setHardwareStatus(statusEl, `Reading ${file.name}...`, null);

  try {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch (err) {
      // JSON.parse's own message names a byte offset, which tells the user nothing useful.
      throw new Error("That file is not valid JSON.");
    }
    const result = await HardwareApi.importBackup(payload);

    // A section the file didn't carry is left out of the count entirely, rather than reported as
    // zero: an older curves-only export restoring "0 runs" would read like the runs were lost.
    const present = BACKUP_SECTIONS.filter(([, key]) => result[key] !== null);
    const parts = [`Imported ${present.map(([word, key]) => backupCount(result[key].imported.length, word)).join(", ")}.`];
    const skipped = present.reduce((sum, [, key]) => sum + result[key].skipped.length, 0);
    const rejected = present.flatMap(([word, key]) => result[key].rejected.map((item) => ({ ...item, word })));
    const dropped = result.measurements?.dropped ?? 0;
    if (skipped > 0) parts.push(`${skipped} already here, left as they were.`);
    if (rejected.length > 0) parts.push(`${rejected.length} rejected.`);
    // The one case where an import can cost you something that was already here.
    if (dropped > 0) parts.push(`${dropped} of the oldest readings fell past the reading-log limit.`);
    setHardwareStatus(statusEl, parts.join(" "),
      rejected.length > 0 || dropped > 0 ? "warn" : "success");

    for (const { word, id, reason } of rejected) {
      const item = hwEl("li");
      item.append(hwEl("b", null, `${word} ${id}`), `: ${reason}`);
      detail.appendChild(item);
    }
    detail.hidden = rejected.length === 0;

    await refreshBackupSummary();
    // A restored curve can change what the active-curve card says.
    loadInstrumentStatus();
  } catch (err) {
    console.error("Backup import failed:", err);
    setHardwareStatus(statusEl, `Import failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
    updateBackupImportControls();
  }
}

// ---- Reset ------------------------------------------------------------------
// Deletes everything this software stores in the browser. There is no undo, so it takes two
// deliberate steps (open the panel, then type the word), shows exactly what goes and whether it
// was ever backed up, and puts the backup one click away inside the panel. After the delete it
// checks that the storage is actually empty instead of trusting that removal worked.

const RESET_CONFIRM_WORD = "DELETE";

function resetTotal(preview) {
  return preview.runs + preview.curves + preview.readings;
}

// The Delete button is blocked when there is nothing to delete, and says so.
async function refreshResetOpenButton() {
  const openButton = document.getElementById("reset-open-button");
  try {
    const preview = await HardwareApi.getResetPreview();
    setBlocked(openButton, document.getElementById("reset-open-reason"),
      resetTotal(preview) === 0 && preview.keys === 0 ? "Nothing stored in this browser." : null);
  } catch (err) {
    console.error("Could not read what is stored:", err);
    // Leave it usable: failing to preview must never be the reason a delete can't be done.
    setBlocked(openButton, document.getElementById("reset-open-reason"), null);
  }
}

// What is about to be deleted, and how much of it exists nowhere else.
async function refreshResetPanel() {
  const summaryEl = document.getElementById("reset-summary");
  const warningEl = document.getElementById("reset-warning");
  const exportButton = document.getElementById("reset-export-button");

  let preview;
  try {
    preview = await HardwareApi.getResetPreview();
  } catch (err) {
    console.error("Could not read what is stored:", err);
    summaryEl.textContent = `Could not read what is stored: ${err.message}`;
    warningEl.hidden = true;
    return;
  }

  const total = resetTotal(preview);
  const counts = [["run", preview.runs], ["curve", preview.curves], ["reading", preview.readings]];
  summaryEl.textContent = total > 0
    ? `This deletes ${counts.map(([word, n]) => backupCount(n, word)).join(" · ")}.`
    : "There are no runs, curves, or readings. This clears the remembered page state.";

  // Only worth warning about when there is something to lose.
  warningEl.hidden = total === 0;
  exportButton.hidden = total === 0;
  if (total > 0) {
    const parts = [];
    if (preview.unexported_readings > 0) {
      parts.push(`${backupCount(preview.unexported_readings, "reading")} never exported.`);
    }
    // A backup time can't say what was added after it, so it is never presented as "all safe".
    parts.push(lastBackupUtc()
      ? `${lastBackupText()} Anything added since is not in it.`
      : "No backup has been made from this browser.");
    warningEl.textContent = parts.join(" ");
  }
}

function updateResetConfirmControls() {
  const typed = document.getElementById("reset-confirm-input").value.trim();
  setBlocked(document.getElementById("reset-confirm-button"), document.getElementById("reset-confirm-reason"),
    typed === RESET_CONFIRM_WORD ? null : `Type ${RESET_CONFIRM_WORD} to enable.`);
}

function closeResetPanel() {
  document.getElementById("reset-panel").hidden = true;
  document.getElementById("reset-confirm-input").value = "";
  document.getElementById("reset-open-button").hidden = false;
  refreshResetOpenButton();
}

async function openResetPanel() {
  const openButton = document.getElementById("reset-open-button");
  if (openButton.disabled) return;

  setHardwareStatus(document.getElementById("reset-status"), "", null);
  document.getElementById("reset-confirm-input").value = "";
  updateResetConfirmControls();
  await refreshResetPanel();
  openButton.hidden = true;
  document.getElementById("reset-panel").hidden = false;
  document.getElementById("reset-confirm-input").focus();
}

async function confirmReset() {
  const confirmButton = document.getElementById("reset-confirm-button");
  const statusEl = document.getElementById("reset-status");
  if (confirmButton.disabled) return;
  // Re-checked here as well as in the button state: the typed word is the whole safeguard.
  if (document.getElementById("reset-confirm-input").value.trim() !== RESET_CONFIRM_WORD) return;

  const panelButtons = document.querySelectorAll("#reset-panel button");
  panelButtons.forEach((button) => { button.disabled = true; });
  setHardwareStatus(statusEl, "Deleting...", null);

  try {
    const result = await HardwareApi.resetAll();
    const after = await HardwareApi.getResetPreview();
    const leftover = resetTotal(after) > 0 || after.keys > 0 || result.remaining.length > 0;

    if (result.storage_unavailable) {
      // Nothing was ever persisted, so there is nothing more to delete; only the memory copy existed.
      setHardwareStatus(statusEl,
        "This browser blocks storage, so nothing was saved on disk. The copy held in memory was cleared.", "warn");
    } else if (leftover) {
      setHardwareStatus(statusEl,
        `Deletion did not complete: ${backupCount(result.remaining.length || after.keys, "stored item")} still present. `
        + "Clear this site's data in the browser settings.", "error");
    } else {
      setHardwareStatus(statusEl,
        "Deleted. This browser now holds no runs, curves, or readings, and the defaults are restored.", "success");
    }
  } catch (err) {
    console.error("Reset failed:", err);
    setHardwareStatus(statusEl, `Reset failed: ${err.message}`, "error");
  } finally {
    // Whatever happened, what the page shows has to be re-read from storage.
    closeResetPanel();
    panelButtons.forEach((button) => { button.disabled = false; });
    updateResetConfirmControls();
    refreshBackupSummary();
    renderDarkReadAlert();
    loadInstrumentStatus();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadInstrumentStatus();
  setInterval(renderDarkReadAlert, DARK_READ_ALERT_REFRESH_MS);
  document.getElementById("dark-read-button").addEventListener("click", () => runInstrumentCheck("dark"));
  document.getElementById("blank-read-button").addEventListener("click", () => runInstrumentCheck("blank"));

  refreshBackupSummary();
  updateBackupImportControls();
  // A wrapper, not the function itself: a click would otherwise pass the event as the first argument.
  document.getElementById("backup-export-button").addEventListener("click", () => exportBackup());
  document.getElementById("backup-import-form").addEventListener("submit", importBackup);
  document.getElementById("backup-import-file").addEventListener("change", updateBackupImportControls);

  refreshResetOpenButton();
  updateResetConfirmControls();
  document.getElementById("reset-open-button").addEventListener("click", openResetPanel);
  document.getElementById("reset-cancel-button").addEventListener("click", () => {
    setHardwareStatus(document.getElementById("reset-status"), "", null);
    closeResetPanel();
  });
  document.getElementById("reset-confirm-input").addEventListener("input", updateResetConfirmControls);
  document.getElementById("reset-confirm-button").addEventListener("click", confirmReset);
  document.getElementById("reset-export-button").addEventListener("click", () =>
    exportBackup(document.getElementById("reset-export-button"), document.getElementById("reset-status")));
});
