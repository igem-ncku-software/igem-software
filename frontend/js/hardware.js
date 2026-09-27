// =========================================================
// Backs hardware.html: step 1 of the CAPTURE-Screen workflow, the instrument itself.
// Target elements:
//   #status-verdict(-title / -detail)            connection and self-check status
//   #node-{backend,device,sensor,led} / #link-{device,stem,sensor,led}   the signal path
//   #status-details / #status-config-body       the Current configuration table
//   #self-check-button / #self-check-reason / #self-check-status / #self-check-result
// Backing API (js/hardware_api.js): getDeviceStatus / runSelfCheck
// The status is polled on the step bar's interval, so the page follows the device without a reload.
// =========================================================

// The two dark frames of one read should agree to within read noise; a larger change means the
// light reaching the sensor changed during the read.
const DARK_DRIFT_TOLERANCE_COUNTS = 2;
const POLL_SECONDS = DEVICE_STATUS_POLL_INTERVAL_MS / 1000;

let instrumentStatus = null;   // the last getDeviceStatus() that succeeded, or null
let instrumentError = null;    // why the last one failed, or null
let statusSeq = 0;             // polls overlap a self-check's refresh; only the newest one is applied
let selfCheckRunning = false;
// {at: Date, fingerprint, problems: string[]} from this page session, or null. The fingerprint is the
// config the check ran under: a check says nothing about a config it didn't run on.
let lastSelfCheck = null;
// Keep the latest incomplete attempt separate from completed checks, so a failed retry
// cannot restore an earlier pass. Earlier passes are history only, always labelled by config.
let lastSelfCheckError = null; // {at: Date, message: string}, cleared by a completed check
let lastPassedSelfCheck = null;

// Grouped "60,000" whatever the browser's locale, like the fixed time format: a de-DE browser
// would otherwise write "60.000" into an English interface.
function formatCounts(value, signed = false) {
  if (!Number.isFinite(value)) return "--";
  return `${signed && value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;
}

function formatUptime(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

// ---- Status ----------------------------------------------------------------

async function refreshInstrument() {
  const seq = ++statusSeq;
  let status = null;
  let error = null;
  try {
    status = await HardwareApi.getDeviceStatus();
  } catch (err) {
    error = err;
  }
  if (seq !== statusSeq) return;
  instrumentStatus = status;
  instrumentError = error;
  renderInstrument();
  applySelfCheckBlock();
}

// Which link of the path answered last: the first one that didn't is where the problem is.
function linkState() {
  if (instrumentStatus) return "online";
  if (!instrumentError) return "checking";
  if (instrumentError.backendUnreachable) return "unreachable";
  if (instrumentError.deviceOffline) return "offline";
  if (instrumentError.deviceInvalid) return "invalid";
  return "backend-error";
}

function renderInstrument() {
  renderVerdict();
  renderPath();
  const details = document.getElementById("status-details");
  // Never left showing an old config: a device that comes back may run a different one.
  details.hidden = !instrumentStatus;
  if (instrumentStatus) renderConfig(document.getElementById("status-config-body"), instrumentStatus);
}

// {tone, title, detail}: connection and self-check status, not calibration/measurement readiness.
function instrumentVerdict() {
  const status = instrumentStatus;
  switch (linkState()) {
    case "checking":
      return { tone: null, title: "Checking the instrument...", detail: "" };
    case "unreachable":
      return { tone: "error", title: "Not ready: backend not reachable",
        detail: `May be waking up (up to a minute). Retrying every ${POLL_SECONDS} s.` };
    case "backend-error":
      return { tone: "error", title: "Not ready: backend error", detail: instrumentError.message };
    case "offline":
      return { tone: "error", title: "Not ready: CAPTURE-Screen is offline",
        detail: `${deviceLastSeen()}. Check its power and Wi-Fi.` };
    case "invalid":
      return { tone: "error", title: "Not ready: unexpected status from CAPTURE-Screen",
        detail: "Status didn't validate. See the browser console for details." };
    default:
      break;
  }
  if (status.sensor_ok === false) {
    return { tone: "error", title: "Not ready: AS7341 sensor not responding",
      detail: "Check the I2C wiring. It reconnects automatically within seconds." };
  }
  if (selfCheckRunning) {
    return { tone: "warn", title: "Self-check in progress", detail: "Reading dark · light · dark." };
  }
  if (status.state === "MEASURING") {
    return { tone: "warn", title: "Busy: reading in progress", detail: "Finishes in a few seconds." };
  }
  const notes = [`Config ${status.config.fingerprint}`];
  if (status.sensor_ok === null) notes.push("Sensor health not reported by this firmware");
  if (lastSelfCheckError) {
    const { at, message } = lastSelfCheckError;
    return { tone: "warn", title: "Self-check incomplete",
      detail: [`Read failed at ${formatClockTime(at)}: ${message}. Run it again.`, previousSelfCheckPass(), ...notes].filter(Boolean).join(" · ") };
  }
  const check = lastSelfCheck?.fingerprint === status.config.fingerprint ? lastSelfCheck : null;
  if (check?.problems.length) {
    return { tone: "warn", title: "Self-check needs attention",
      detail: [`${capitalize(check.problems.join("; "))} (${formatClockTime(check.at)}). Run it again once fixed.`, previousSelfCheckPass(), ...notes].filter(Boolean).join(" · ") };
  }
  if (check) {
    return { tone: "ok", title: "Self-check passed",
      detail: [`Dark readings stable; no light channel saturated (${formatClockTime(check.at)}). LED response is not verified.`, ...notes].join(" · ") };
  }
  return lastSelfCheck
    ? { tone: "warn", title: "Connected · Repeat self-check",
      detail: ["Config changed since the last completed self-check. Run it again.", ...notes].join(" · ") }
    : { tone: null, title: "Connected · Self-check not run",
      detail: ["Run a self-check with buffer before calibrating or measuring.", ...notes].join(" · ") };
}

function previousSelfCheckPass() {
  return lastPassedSelfCheck
    ? `Previous checks passed at ${formatClockTime(lastPassedSelfCheck.at)} (config ${lastPassedSelfCheck.fingerprint})`
    : "";
}

// The device's last contact, for the verdict and its node alike.
function deviceLastSeen() {
  return instrumentError.lastSeen ? `Last seen ${formatAgo(instrumentError.lastSeen)}` : "Not connected yet";
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderVerdict() {
  const { tone, title, detail } = instrumentVerdict();
  const box = document.getElementById("status-verdict");
  box.className = `hw-verdict${tone ? ` is-${tone}` : ""}`;
  const titleEl = document.getElementById("status-verdict-title");
  const detailEl = document.getElementById("status-verdict-detail");
  // Only on change: the box is a live region, and a poll repeating the same words would re-announce them.
  if (titleEl.textContent !== title) titleEl.textContent = title;
  if (detailEl.textContent !== detail) detailEl.textContent = detail;
  detailEl.hidden = !detail;
}

// ---- Signal path -------------------------------------------------------------

// tone: "ok" | "warn" | "error" | null. unknown: nothing is known past a broken link.
function setNode(name, { text, tone = null, sub = "", unknown = false }) {
  const node = document.getElementById(`node-${name}`);
  node.querySelector(".hw-node-text").textContent = text;
  node.querySelector(".status-dot").className = `status-dot${tone ? ` is-${tone}` : ""}`;
  node.querySelector(".hw-node-sub").textContent = sub;
  node.classList.toggle("is-error", tone === "error");
  node.classList.toggle("is-unknown", unknown);
}

// state: "ok" | "broken" | null (unknown).
function setLink(name, state) {
  const link = document.getElementById(`link-${name}`);
  link.classList.toggle("is-ok", state === "ok");
  link.classList.toggle("is-broken", state === "broken");
}

function backendName() {
  const { host } = new URL(BACKEND_BASE_URL);
  return host.endsWith("onrender.com") ? "Render" : host;
}

// Why nothing is known past a broken link, as the node's second line.
const UPSTREAM_CAUSE = {
  unreachable: "Backend unreachable",
  "backend-error": "Backend error",
  offline: "Device offline",
  invalid: "Device status unreadable",
};

function renderPath() {
  const link = linkState();
  const status = instrumentStatus;
  const unknown = link === "checking"
    ? { text: "Checking...", unknown: true }
    : { text: "Unknown", sub: UPSTREAM_CAUSE[link], unknown: true };

  if (link === "checking") setNode("backend", { text: "Checking...", sub: backendName(), unknown: true });
  else if (link === "unreachable") setNode("backend", { text: "Unreachable", tone: "error", sub: `Retrying every ${POLL_SECONDS} s` });
  else if (link === "backend-error") setNode("backend", { text: "Error", tone: "error", sub: "See above" });
  else setNode("backend", { text: "Reachable", tone: "ok", sub: backendName() });

  if (link === "online") {
    setNode("device", { text: "Online", tone: "ok", sub: `Heartbeat ${formatClockTime(new Date(status.last_seen))}` });
  } else if (link === "offline") {
    setNode("device", { text: "Offline", tone: "error", sub: deviceLastSeen() });
  } else if (link === "invalid") {
    setNode("device", { text: "Unreadable", tone: "error", sub: "Status didn't validate" });
  } else {
    setNode("device", unknown);
  }
  setLink("device", link === "online" ? "ok" : ["offline", "invalid"].includes(link) ? "broken" : null);
  setLink("stem", link === "online" ? "ok" : null);

  if (link !== "online") {
    setNode("sensor", unknown);
    setNode("led", unknown);
    setLink("sensor", null);
    setLink("led", null);
    return;
  }

  // The wording is sensorReading()'s, the one rule for sensor_ok on every page.
  const { config } = status;
  const sensor = sensorReading(status.sensor_ok);
  if (status.sensor_ok === true) {
    setNode("sensor", { text: sensor.text, tone: "ok",
      sub: `Gain ${config.gain}× · ${HardwareProcessing.integrationTimeMs(config).toFixed(1)} ms` });
  } else if (status.sensor_ok === false) {
    setNode("sensor", { text: sensor.text, tone: "error", sub: "Check the I2C wiring" });
  } else {
    setNode("sensor", { text: sensor.text, sub: "Older firmware" });
  }
  setLink("sensor", status.sensor_ok === true ? "ok" : status.sensor_ok === false ? "broken" : null);

  setNode("led", ledNode(status));
  setLink("led", "ok");
}

// What the LED is doing, since that is what matters to a cuvette in the reader.
function ledNode(status) {
  if (status.state === "IDLE") return { text: "Off", sub: "Idle" };
  if (status.state === "MEASURING") return { text: "Measuring", tone: "warn", sub: "Dark · light · dark" };
  // LIVE. A firmware without the LED switch always streams lit.
  const autoOff = Number.isFinite(status.live_off_in_s)
    ? ` · auto-off ${formatClockTime(new Date(Date.now() + status.live_off_in_s * 1000), false)}`
    : "";
  return status.led_on === false
    ? { text: "Off", sub: `Live, dark counts${autoOff}` }
    : { text: "On", tone: "ok", sub: `Live${autoOff}` };
}

// ---- Current configuration ------------------------------------------------------

// [parameter, value, note]: measurement settings first, then the fingerprint built from them, then
// the device itself. The note says where each value comes from; the formulas are
// HardwareProcessing's own. Re-rendered only when a value changed, so a poll doesn't wipe out a
// selection someone is copying.
function renderConfig(tbody, status) {
  const { config } = status;
  const rows = [
    ["LED current", `${config.led_current_mA} mA`, "Firmware constant, bench-measured"],
    ["Gain", `${config.gain}×`, "AS7341 analog gain"],
    ["ATIME / ASTEP", `${config.atime} / ${config.astep}`, "AS7341 integration registers"],
    ["Integration time", `${HardwareProcessing.integrationTimeMs(config).toFixed(2)} ms`, "(ATIME + 1) × (ASTEP + 1) × 2.78 µs"],
    ["Full scale", `${formatCounts(HardwareProcessing.fullScaleCounts(config))} counts`, "min(65,535, (ATIME + 1) × (ASTEP + 1))"],
    ["Build ID", config.build_id, "Hardware and reading-path revision"],
    ["Config fingerprint", config.fingerprint, "Hash of LED current, gain, ATIME, ASTEP and build ID; curves are bound to it"],
    ["Device ID", status.device_id, "This unit's assigned name"],
    ["Wi-Fi signal", `${status.wifi_rssi} dBm`, "Signal strength at the device"],
    ["Uptime", formatUptime(status.uptime_ms), "Since the device last started"],
  ];
  const key = JSON.stringify(rows);
  if (tbody.dataset.rendered === key) return;
  tbody.dataset.rendered = key;
  tbody.replaceChildren();
  for (const [label, value, note] of rows) {
    const row = hwEl("tr");
    const valueCell = hwEl("td", "spec-value");
    valueCell.append(label === "Config fingerprint" ? hwFingerprint(value) : value);
    row.append(Object.assign(hwEl("th", null, label), { scope: "row" }), valueCell, hwEl("td", "spec-note", note));
    tbody.appendChild(row);
  }
}

// ---- Self-check --------------------------------------------------------------

function selfCheckBlockReason() {
  switch (linkState()) {
    case "checking": return "Checking status...";
    case "unreachable": return "Backend not reachable.";
    case "backend-error": return "Status unavailable.";
    case "offline": return "CAPTURE-Screen is offline.";
    case "invalid": return "Unexpected status from CAPTURE-Screen.";
    default: break;
  }
  const sensor = sensorReading(instrumentStatus.sensor_ok).blocks;
  if (sensor) return sensor;
  if (instrumentStatus.state === "MEASURING") return "Reading in progress.";
  return null;
}

function applySelfCheckBlock() {
  const button = document.getElementById("self-check-button");
  const reason = document.getElementById("self-check-reason");
  if (selfCheckRunning) {
    setBlocked(button, reason, null);
    button.disabled = true;
    return;
  }
  setBlocked(button, reason, selfCheckBlockReason());
}

async function runSelfCheck() {
  if (selfCheckRunning) return;
  const statusEl = document.getElementById("self-check-status");
  const result = document.getElementById("self-check-result");

  selfCheckRunning = true;
  applySelfCheckBlock();
  result.hidden = true;
  setHardwareStatus(statusEl, "Reading...", null);
  renderVerdict();

  try {
    renderSelfCheck(await HardwareApi.runSelfCheck(), result, statusEl);
  } catch (err) {
    console.error("Self-check failed:", err);
    lastSelfCheckError = { at: new Date(), message: err.message };
    setHardwareStatus(statusEl, `Self-check incomplete at ${formatClockTime(lastSelfCheckError.at)}: ${err.message}. Run again.`, "error");
  } finally {
    selfCheckRunning = false;
    renderVerdict();
    // The block comes from a fresh status, not from how the read went: a failed read says
    // nothing about the sensor, so it leaves the button usable for a retry.
    await refreshInstrument();
  }
}

// "F4 (515 nm)", or just "Clear" / "NIR", which have no single wavelength.
function channelName(ch) {
  return /^\d+$/.test(ch.axis) ? `${ch.key} (${ch.axis} nm)` : ch.key;
}

function perChannel(fn) {
  return Object.fromEntries(HARDWARE_CHANNELS.map(({ key }) => [key, fn(key)]));
}

function countsText(value, signed = false) {
  return `${formatCounts(value, signed)} count${Math.abs(value) === 1 ? "" : "s"}`;
}

// The channel where fn(value) is largest, and its value.
function peakChannel(values, fn = (value) => value) {
  const ch = HARDWARE_CHANNELS.reduce((a, b) => (fn(values[b.key]) > fn(values[a.key]) ? b : a));
  return { ch, value: values[ch.key] };
}

// Everything the result shows, graded once so the result line and the list can't disagree.
// Only drift and saturation are graded: the dark level and the LED's signal have no measured
// baseline on this reader yet, so they are reported as information and never invent a limit.
function analyzeSelfCheck(check) {
  const darks = [check.dark_1, check.dark_2].filter(Boolean);
  const drift = darks.length === 2 ? perChannel((key) => check.dark_2[key] - check.dark_1[key]) : null;
  const net = darks.length
    ? perChannel((key) => check.light[key] - darks.reduce((sum, dark) => sum + dark[key], 0) / darks.length)
    : null;
  const darkMax = darks.length ? perChannel((key) => Math.max(...darks.map((dark) => dark[key]))) : null;
  const fullScale = HardwareProcessing.fullScaleCounts(check.config);
  const driftPeak = drift ? peakChannel(drift, Math.abs) : null;
  const lightPeak = peakChannel(check.light);
  const saturated = HARDWARE_CHANNELS.filter(({ key }) => check.light[key] >= fullScale);
  const stable = driftPeak !== null && Math.abs(driftPeak.value) <= DARK_DRIFT_TOLERANCE_COUNTS;

  // [{text, advice}] for each graded check that failed.
  const problems = [];
  if (saturated.length) {
    problems.push({ text: `saturated on ${saturated.map(channelName).join(", ")}`,
      advice: "Lower the gain (Serial command g), then run again." });
  }
  if (!driftPeak) {
    problems.push({ text: "a dark reading is missing", advice: "Run again." });
  } else if (!stable) {
    problems.push({ text: `dark reading drifted ${countsText(driftPeak.value, true)} on ${channelName(driftPeak.ch)}`,
      advice: "Keep the lid closed and the room light steady, then run again." });
  }
  return { drift, net, darkMax, fullScale, driftPeak, lightPeak, saturated: saturated.length > 0, stable, problems };
}

// verdict: "pass" | "fail" for a graded check, null for information only.
function checkRow(name, value, verdict) {
  const row = hwEl("li", verdict ? `is-${verdict}` : null);
  const [chipText, chipTone] = verdict === "pass" ? ["Pass", "ok"] : verdict === "fail" ? ["Fail", "error"] : ["Info", ""];
  row.append(hwEl("span", "check-name", name), hwEl("span", "check-value", value),
    hwEl("span", `flag-chip ${chipTone}`.trim(), chipText));
  return row;
}

function renderSelfCheck(check, container, statusEl) {
  const result = analyzeSelfCheck(check);
  const { drift, net, darkMax, fullScale, driftPeak, lightPeak, problems } = result;
  const at = new Date(check.timestamp_utc);
  const time = formatClockTime(at);

  lastSelfCheck = { at, fingerprint: check.config.fingerprint, problems: problems.map((p) => p.text) };
  lastSelfCheckError = null;
  if (problems.length) {
    const advice = [...new Set(problems.map((p) => p.advice))].join(" ");
    setHardwareStatus(statusEl, `Failed at ${time}: ${problems.map((p) => p.text).join("; ")}. ${advice}`, "error");
  } else {
    lastPassedSelfCheck = lastSelfCheck;
    setHardwareStatus(statusEl, `Checks passed at ${time}: dark readings are stable; no light channel is saturated.`, "success");
  }

  const list = hwEl("ul", "check-list");
  list.append(
    checkRow("Dark stability", driftPeak ? `${countsText(driftPeak.value, true)} (limit ±${DARK_DRIFT_TOLERANCE_COUNTS})` : "--",
      result.stable ? "pass" : "fail"),
    checkRow("Peak signal", `${formatPercent(lightPeak.value / fullScale)} of full scale`, result.saturated ? "fail" : "pass"),
    checkRow("Dark level", darkMax ? countsText(peakChannel(darkMax).value) : "--", null),
    checkRow("Light − dark", net ? countsText(peakChannel(net).value, true) : "--", null),
  );

  // The full per-channel numbers stay one click away: the list summarises, the table is the record.
  const counts = (value) => formatCounts(value);
  const raw = hwEl("details", "raw-details");
  raw.append(
    hwEl("summary", null, "Raw counts per channel"),
    renderChannelTable("Raw counts", [
      { label: "Dark 1", values: check.dark_1, format: counts },
      { label: "Light", values: check.light, format: counts },
      { label: "Dark 2", values: check.dark_2, format: counts },
      { label: "Dark drift", values: drift, format: (value) => formatCounts(value, true) },
      { label: "Light − dark", values: net, format: counts },
    ]),
  );

  const scope = hwEl("p", "plan-meta", "Dark level and light − dark are informational; LED response is not verified.");
  container.replaceChildren(list, scope, raw);
  container.hidden = false;
}

document.addEventListener("DOMContentLoaded", () => {
  renderInstrument();
  applySelfCheckBlock();
  refreshInstrument();
  setInterval(refreshInstrument, DEVICE_STATUS_POLL_INTERVAL_MS);
  document.getElementById("self-check-button").addEventListener("click", runSelfCheck);
});
