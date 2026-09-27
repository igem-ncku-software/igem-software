// =========================================================
// Backs hardware.html: step 1 of the CAPTURE-Screen workflow, the instrument itself.
// Target elements:
//   #status-verdict(-title / -detail)            the one answer to "can I measure now?"
//   #node-{backend,device,sensor,led} / #link-{device,stem,sensor,led}   the signal path
//   #status-details / #status-config-body       the Current configuration table
//   #self-check-button / #self-check-reason / #self-check-status / #self-check-result
//   #status-log                                  the session log
// Backing API (js/hardware_api.js): getDeviceStatus / runSelfCheck
// The status is polled on the step bar's interval, so the page follows the device without a reload.
// =========================================================

// The two dark frames of one read should agree to within read noise; a larger change means the
// light reaching the sensor changed during the read.
const DARK_DRIFT_TOLERANCE_COUNTS = 2;
const STATUS_LOG_LIMIT = 100;
const POLL_SECONDS = DEVICE_STATUS_POLL_INTERVAL_MS / 1000;

let instrumentStatus = null;   // the last getDeviceStatus() that succeeded, or null
let instrumentError = null;    // why the last one failed, or null
let statusSeq = 0;             // polls overlap a self-check's refresh; only the newest one is applied
let selfCheckRunning = false;
let lastSelfCheck = null;      // {at: Date, problems: string[]} from this page session, or null
let observed = null;           // what the session log last saw, to log only changes

function formatCounts(value, signed = false) {
  if (!Number.isFinite(value)) return "--";
  return `${signed && value > 0 ? "+" : ""}${value.toLocaleString()}`;
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
  logChanges();
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

// {tone, title, detail}: the reason and what to do, for the first thing that stops a reading.
function instrumentVerdict() {
  const status = instrumentStatus;
  switch (linkState()) {
    case "checking":
      return { tone: null, title: "Checking the instrument...", detail: "" };
    case "unreachable":
      return { tone: "error", title: "Not ready: backend not reachable",
        detail: `It may be waking up, which can take up to a minute. Retrying every ${POLL_SECONDS} s.` };
    case "backend-error":
      return { tone: "error", title: "Not ready: backend error", detail: instrumentError.message };
    case "offline":
      return { tone: "error", title: "Not ready: CAPTURE-Screen is offline",
        detail: `${instrumentError.lastSeen ? `Last seen ${formatAgo(instrumentError.lastSeen)}` : "Not connected since the backend started"}. Check its power and Wi-Fi.` };
    case "invalid":
      return { tone: "error", title: "Not ready: unexpected status from CAPTURE-Screen",
        detail: "Its status message didn't validate. Check that its firmware matches this site." };
    default:
      break;
  }
  if (status.sensor_ok === false) {
    return { tone: "error", title: "Not ready: AS7341 sensor not responding",
      detail: "Check its I2C wiring. The device reconnects it within seconds once it answers." };
  }
  if (status.state === "MEASURING") {
    return { tone: "warn", title: "Busy: a reading is in progress", detail: "Wait a few seconds for it to finish." };
  }
  if (lastSelfCheck?.problems.length) {
    return { tone: "warn", title: "Online, but the last self-check failed",
      detail: `${formatClockTime(lastSelfCheck.at)}: ${lastSelfCheck.problems.join("; ")}. Fix it and run the self-check again.` };
  }
  const notes = [`Config ${status.config.fingerprint}`];
  notes.push(lastSelfCheck ? `Self-check passed ${formatClockTime(lastSelfCheck.at)}` : "No self-check in this session");
  if (status.sensor_ok === null) notes.push("Sensor health not reported by this firmware");
  return { tone: "ok", title: "Ready to measure", detail: notes.join(" · ") };
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

function renderPath() {
  const link = linkState();
  const status = instrumentStatus;
  const behind = (what) => (link === "checking"
    ? { text: "Checking...", unknown: true }
    : { text: "Unknown", sub: `Behind the ${what}`, unknown: true });

  if (link === "checking") setNode("backend", { text: "Checking...", sub: backendName(), unknown: true });
  else if (link === "unreachable") setNode("backend", { text: "Unreachable", tone: "error", sub: `Retrying every ${POLL_SECONDS} s` });
  else if (link === "backend-error") setNode("backend", { text: "Error", tone: "error", sub: "See above" });
  else setNode("backend", { text: "Reachable", tone: "ok", sub: backendName() });

  if (link === "online") {
    setNode("device", { text: "Online", tone: "ok", sub: `Heartbeat ${formatClockTime(new Date(status.last_seen))}` });
  } else if (link === "offline") {
    setNode("device", { text: "Offline", tone: "error",
      sub: instrumentError.lastSeen ? `Last seen ${formatAgo(instrumentError.lastSeen)}` : "Not connected yet" });
  } else if (link === "invalid") {
    setNode("device", { text: "Unreadable", tone: "error", sub: "Status didn't validate" });
  } else {
    setNode("device", behind("backend"));
  }
  setLink("device", link === "online" ? "ok" : ["offline", "invalid"].includes(link) ? "broken" : null);
  setLink("stem", link === "online" ? "ok" : null);

  if (link !== "online") {
    setNode("sensor", behind("device"));
    setNode("led", behind("device"));
    setLink("sensor", null);
    setLink("led", null);
    return;
  }

  const { config } = status;
  if (status.sensor_ok === true) {
    setNode("sensor", { text: "Responding", tone: "ok",
      sub: `Gain ${config.gain}× · ${HardwareProcessing.integrationTimeMs(config).toFixed(1)} ms` });
  } else if (status.sensor_ok === false) {
    setNode("sensor", { text: "Not responding", tone: "error", sub: "Check the I2C wiring" });
  } else {
    setNode("sensor", { text: "Not reported", sub: "By this firmware" });
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
    ["Config fingerprint", config.fingerprint, "Hash of LED current, gain, ATIME, ASTEP and build ID; every curve is bound to one"],
    ["Device ID", status.device_id, "Name this unit reports"],
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

// ---- Session log -------------------------------------------------------------------
// Only what this page saw while open, at the moment a poll noticed it (up to one poll interval
// late); a disconnect shorter than that is missed, but a restart still shows, because uptime drops.

function addLog(text, tone = null) {
  const list = document.getElementById("status-log");
  const item = hwEl("li", tone ? `is-${tone}` : null);
  item.append(hwEl("time", null, formatClockTime(new Date())), hwEl("span", null, text));
  list.prepend(item);
  while (list.children.length > STATUS_LOG_LIMIT) list.lastElementChild.remove();
}

const LINK_LOG = {
  online: () => ["CAPTURE-Screen online", "ok"],
  offline: () => ["CAPTURE-Screen offline", "error"],
  unreachable: () => ["Backend not reachable", "error"],
  "backend-error": () => [`Backend error: ${instrumentError.message}`, "error"],
  invalid: () => ["Unexpected status from CAPTURE-Screen", "error"],
};

function logChanges() {
  const link = linkState();
  const status = instrumentStatus;
  if (!observed) {
    const { tone, title } = instrumentVerdict();
    addLog(`Page opened · ${title}`, tone);
    observed = { link, sensor: status?.sensor_ok, uptime: status?.uptime_ms, fingerprint: status?.config.fingerprint, live: liveOn(status) };
    return;
  }

  if (link !== observed.link && LINK_LOG[link]) addLog(...LINK_LOG[link]());
  observed.link = link;
  if (!status) return;

  // Uptime and config are compared with the last values seen online, across any offline gap.
  if (observed.uptime !== undefined && status.uptime_ms < observed.uptime) {
    addLog(`CAPTURE-Screen restarted (uptime ${formatUptime(status.uptime_ms)})`, "warn");
  }
  if (observed.fingerprint && status.config.fingerprint !== observed.fingerprint) {
    addLog(`Config changed ${observed.fingerprint} → ${status.config.fingerprint}; curves fitted under ${observed.fingerprint} no longer apply`, "warn");
  }
  if (observed.sensor !== undefined && status.sensor_ok !== observed.sensor) {
    if (status.sensor_ok === false) addLog("AS7341 stopped responding", "error");
    else if (status.sensor_ok === true) addLog("AS7341 responding", "ok");
  }
  const live = liveOn(status);
  if (observed.live !== undefined && live !== observed.live) addLog(live ? "Live on" : "Live off");

  Object.assign(observed, { sensor: status.sensor_ok, uptime: status.uptime_ms, fingerprint: status.config.fingerprint, live });
}

function liveOn(status) {
  return status ? (status.live_on ?? status.state === "LIVE") : undefined;
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
  if (instrumentStatus.state === "MEASURING") return "Measurement in progress.";
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
  const statusEl = document.getElementById("self-check-status");
  const result = document.getElementById("self-check-result");

  selfCheckRunning = true;
  applySelfCheckBlock();
  result.hidden = true;
  setHardwareStatus(statusEl, "Reading...", null);

  try {
    renderSelfCheck(await HardwareApi.runSelfCheck(), result, statusEl);
  } catch (err) {
    console.error("Self-check failed:", err);
    setHardwareStatus(statusEl, `Read failed: ${err.message}`, "error");
    addLog(`Self-check read failed: ${err.message}`, "error");
  } finally {
    selfCheckRunning = false;
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

// No limit on the dark level itself: there is no measured baseline for this instrument yet, so
// the page shows the two darks and leaves judging them to the user.
function selfCheckProblems(check, drift) {
  const problems = [];
  const fullScale = HardwareProcessing.fullScaleCounts(check.config);
  const saturated = HARDWARE_CHANNELS.filter(({ key }) => check.light[key] >= fullScale);
  if (saturated.length) {
    problems.push(`saturated on ${saturated.map(channelName).join(", ")} (full scale ${formatCounts(fullScale)} counts)`);
  }
  if (!drift) {
    problems.push("a dark frame is missing, so drift wasn't checked");
  } else {
    const worst = HARDWARE_CHANNELS.reduce((a, b) => (Math.abs(drift[b.key]) > Math.abs(drift[a.key]) ? b : a));
    if (Math.abs(drift[worst.key]) > DARK_DRIFT_TOLERANCE_COUNTS) {
      problems.push(`dark drift ${formatCounts(drift[worst.key], true)} counts on ${channelName(worst)}`);
    }
  }
  return problems;
}

function renderSelfCheck(check, container, statusEl) {
  const darks = [check.dark_1, check.dark_2].filter(Boolean);
  const drift = darks.length === 2 ? perChannel((key) => check.dark_2[key] - check.dark_1[key]) : null;
  const net = darks.length
    ? perChannel((key) => check.light[key] - darks.reduce((sum, dark) => sum + dark[key], 0) / darks.length)
    : null;

  const problems = selfCheckProblems(check, drift);
  lastSelfCheck = { at: new Date(check.timestamp_utc), problems };
  if (problems.length) {
    setHardwareStatus(statusEl, `Fail: ${problems.join("; ")}.`, "error");
    addLog(`Self-check failed: ${problems.join("; ")}`, "error");
  } else {
    setHardwareStatus(statusEl, `Pass: dark drift within ±${DARK_DRIFT_TOLERANCE_COUNTS} counts, no saturation.`, "success");
    addLog("Self-check passed", "ok");
  }

  const counts = (value) => formatCounts(value);
  container.replaceChildren(
    hwEl("h3", "subsection-heading", `Result · ${formatLocalTime(check.timestamp_utc)}`),
    renderChannelTable("Raw counts", [
      { label: "Dark 1", values: check.dark_1, format: counts },
      { label: "Light", values: check.light, format: counts },
      { label: "Dark 2", values: check.dark_2, format: counts },
      { label: "Dark drift", values: drift, format: (value) => formatCounts(value, true) },
      { label: "Light − dark", values: net, format: counts },
    ]),
  );
  container.hidden = false;
}

document.addEventListener("DOMContentLoaded", () => {
  renderInstrument();
  applySelfCheckBlock();
  refreshInstrument();
  setInterval(refreshInstrument, DEVICE_STATUS_POLL_INTERVAL_MS);
  document.getElementById("self-check-button").addEventListener("click", runSelfCheck);
});
