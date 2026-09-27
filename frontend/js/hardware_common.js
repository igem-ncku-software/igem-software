// =========================================================
// Shared across the hardware pages: the step bar (the four workflow steps in order, each with
// its live state, plus the Data page off to the side), the "Next step" link at the bottom of a
// page, number formatting, QC flag chips, the AS7341 channel table, disabled-button reason text,
// sensor health, and the unmixing-basis note.
// Target elements: #hardware-subnav (data-page marks the current page), #hardware-next
//   (data-next names the step after this page), [data-basis-note]
// Depends on js/hardware_api.js's HardwareApi, so this must load after it and before every page's own script.
// =========================================================

// The workflow, in the order it is used. Every page shows all four with their state, so a user
// always sees where they are and what comes next.
const HARDWARE_STEPS = [
  { key: "instrument", href: "hardware.html", label: "Instrument", next: "Check the reader and its config" },
  { key: "calibration", href: "hardware-calibration.html", label: "Calibrate", next: "Read standards and fit a curve" },
  { key: "curves", href: "hardware-curves.html", label: "Curves", next: "Review the saved curves" },
  { key: "measure", href: "hardware-measure.html", label: "Measure", next: "Read samples through a curve" },
];
// Not a step: backup, restore and reset serve the whole workflow.
const HARDWARE_DATA_PAGE = { key: "data", href: "hardware-data.html", label: "Data" };

const DEVICE_STATUS_POLL_INTERVAL_MS = 12000;

// Unit for Measurement's fluorescence / scatter / raw:
// (light - dark) / (gain x integration_time_ms), see js/hardware_processing.js.
const HARDWARE_FLUORESCENCE_UNIT = "basic counts";

// AS7341 channel order and center wavelengths. The key is the data contract's name
// (Measurement.raw); axis labels match the landing page's live view: wavelength numbers,
// with Clear and NIR abbreviated.
const HARDWARE_CHANNELS = [
  { key: "F1", axis: "415" },
  { key: "F2", axis: "445" },
  { key: "F3", axis: "480" },
  { key: "F4", axis: "515" },
  { key: "F5", axis: "555" },
  { key: "F6", axis: "590" },
  { key: "F7", axis: "630" },
  { key: "F8", axis: "680" },
  { key: "Clear", axis: "Clr" },
  { key: "NIR", axis: "NIR" },
];

// Chip color: error means this reading can't be used, warn means it can but needs attention.
const FLAG_SEVERITY = {
  SATURATED: "error",
  NO_DARK_PAIR: "error",
  STALE_CONFIG: "error",
  HIGH_SCATTER: "warn",
};

// Chart.js needs an actual color code and can't consume a CSS variable directly, so it's
// read out here — css/style.css's :root stays the one source of truth for colors.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---- Display rules: concentration to 1 dp (>1000 nM switches to µM), fluorescence to 4 sig figs, percent to 1 dp ----

function formatConcentration(nM) {
  if (nM === null || nM === undefined || !Number.isFinite(nM)) return "--";
  return nM > 1000 ? `${(nM / 1000).toFixed(1)} µM` : `${nM.toFixed(1)} nM`;
}

function formatConcentrationInterval(interval) {
  if (!interval) return "--";
  return `${formatConcentration(interval[0])} – ${formatConcentration(interval[1])}`;
}

// Basic counts range from 0.001 to the thousands (the real device normalizes to roughly
// 0.05-5); a fixed decimal count would round small values to 0, so this uses 4 significant
// figures instead, rounding to an integer only above 1000.
function formatFluorescence(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  if (value === 0) return "0";
  if (Math.abs(value) >= 1000) return String(Math.round(value));
  return String(Number(value.toPrecision(4)));
}

// For signed fluorescence values, such as residuals.
function formatSignedFluorescence(value) {
  if (!Number.isFinite(value)) return "--";
  const text = formatFluorescence(value);
  return value > 0 && text !== "0" ? `+${text}` : text;
}

function formatPercent(fraction) {
  if (!Number.isFinite(fraction)) return "--";
  return `${(fraction * 100).toFixed(1)}%`;
}

// Data is always stored in UTC; the display always shows the browser's local time.
function formatLocalTime(utc) {
  return utc ? new Date(utc).toLocaleString() : "--";
}

function formatAgo(utc) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(utc)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function formatHours(h) {
  return Number.isFinite(h) ? `${+h.toFixed(2)} h` : "--";
}

// A curve's or run's conditions on one line: the two things a sample has to match.
function formatConditions(conditions) {
  if (!conditions) return "--";
  return `${conditions.sensor} · ${formatHours(conditions.induction_h)} induction`;
}

// An InverseEstimate as text. A number only for "ok": outside the range only the bound is shown,
// never an extrapolation. limits is the curve (or a batch's snapshot of it).
function formatEstimate(estimate, limits) {
  switch (estimate?.status) {
    case "ok": return formatConcentration(estimate.concentration_nM);
    case "below_lod": return limits ? `< ${formatConcentration(limits.range_nM.min)}` : "< LOD";
    case "above_range": return limits ? `> ${formatConcentration(limits.range_nM.max)}` : "> range";
    case "no_tubes": return "No tubes";
    default: return "--";
  }
}

// Why a curve can't convert readings on the instrument as it is now, or null if it can.
// fingerprint / signal null means the instrument (or the basis) couldn't be reached.
function curveBlockReason(curve, fingerprint, signal) {
  if (fingerprint === null) return "Instrument unreachable, so its config can't be checked.";
  if (curve.config_fingerprint !== fingerprint) return `Fitted under config ${curve.config_fingerprint}; the instrument now runs ${fingerprint}.`;
  if (signal !== null && curve.signal !== signal) return `Fitted on signal ${curve.signal}; readings are now ${signal}.`;
  return null;
}

// The 4PL equation itself (no fitting). Parameters always come from the API's returned CalibrationCurve.
function fourPL(c, params) {
  if (c <= 0) return params.bottom;
  return params.bottom + (params.top - params.bottom) / (1 + (params.ec50_nM / c) ** params.hill);
}

// ---- DOM helpers -----------------------------------------------------

function hwEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function hwLink(href, text) {
  const a = hwEl("a", "text-link", text);
  a.href = href;
  return a;
}

function hwFingerprint(fingerprint) {
  return hwEl("span", "fingerprint", fingerprint);
}

function setHardwareStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = "status-message" + (kind ? ` ${kind}` : "");
}

// A button disabled because the action "isn't possible yet" must always show why next to it, not just gray out.
// An empty string / null reason enables the button and hides the explanation.
function setBlocked(button, reasonEl, reason) {
  button.disabled = Boolean(reason);
  button.classList.toggle("is-blocked", Boolean(reason));
  if (reasonEl) {
    reasonEl.textContent = reason || "";
    reasonEl.hidden = !reason;
  }
}

// A numbered step card within a page (.step-card): "done", "current", or "waiting" — a waiting
// step keeps its body hidden and says what it is waiting for, the same rule as a blocked button.
const STEP_CARD_CHIP = { done: ["Done", "ok"], current: ["Now", "warn"], waiting: ["Waiting", ""] };

function setStepCard(card, state, waitingReason = null) {
  card.dataset.state = state;
  const [text, tone] = STEP_CARD_CHIP[state];
  const chip = card.querySelector(".step-card-state");
  if (chip) {
    chip.textContent = text;
    chip.className = `flag-chip step-card-state ${tone}`.trim();
  }
  const body = card.querySelector(".step-card-body");
  if (body) body.hidden = state === "waiting";
  const reason = card.querySelector(".step-card-waiting");
  if (reason) {
    reason.textContent = state === "waiting" ? waitingReason ?? "" : "";
    reason.hidden = state !== "waiting" || !waitingReason;
  }
}

// DeviceStatus.sensor_ok -> what to show and whether reading is possible at all. Every page
// that reads uses this, so the wording and the rule stay in one place.
//   false  the AS7341 isn't answering the bus; every read would come back sensor_offline
//   true   it answered within the last couple of seconds (the firmware re-checks on a timer)
//   null   a firmware older than the field: unknown, never "fine". Nothing is blocked, since
//          that is the state every device was in before, and a failed read still says so.
function sensorReading(sensorOk) {
  if (sensorOk === false) {
    return { text: "Not responding", tone: "error", blocks: "The AS7341 is not responding, so no reading can be taken." };
  }
  if (sensorOk === true) return { text: "Responding", tone: null, blocks: null };
  return { text: "Not reported by this firmware", tone: null, blocks: null };
}

function renderFlagChips(flags) {
  const row = hwEl("div", "chip-row");
  if (!flags || flags.length === 0) {
    row.appendChild(hwEl("span", "flag-chip ok", "QC pass"));
    return row;
  }
  for (const flag of flags) {
    row.appendChild(hwEl("span", `flag-chip ${FLAG_SEVERITY[flag] ?? "warn"}`, flag));
  }
  return row;
}

// A stat tile: a label, a large value, and one line of supporting text.
function hwStatTile(label, value, sub) {
  const tile = hwEl("div", "sensor-stat");
  tile.appendChild(hwEl("span", "sensor-stat-label", label));
  tile.appendChild(hwEl("span", "sensor-stat-value", value));
  if (sub) tile.appendChild(hwEl("span", "sensor-stat-sub", sub));
  return tile;
}

// One row of a key/value table; value can be a string or a DOM node.
function appendKvRow(tbody, label, value) {
  const row = hwEl("tr");
  const th = hwEl("th", null, label);
  th.scope = "row";
  const td = hwEl("td");
  if (value instanceof Node) td.appendChild(value);
  else td.textContent = value;
  row.append(th, td);
  tbody.appendChild(row);
}

// A ten-channel value table (used by the instrument status page for dark / blank readings).
function renderChannelTable(raw) {
  const wrapper = hwEl("div", "table-wrapper table-spaced");
  const table = hwEl("table", "channel-table");
  const head = hwEl("tr");
  const body = hwEl("tr");
  head.appendChild(Object.assign(hwEl("th", null, "Channel (nm)"), { scope: "row" }));
  body.appendChild(Object.assign(hwEl("th", null, "Basic counts"), { scope: "row" }));
  for (const { key, axis } of HARDWARE_CHANNELS) {
    head.appendChild(Object.assign(hwEl("th", null, axis), { scope: "col" }));
    body.appendChild(hwEl("td", null, formatFluorescence(raw[key])));
  }
  const thead = hwEl("thead");
  thead.appendChild(head);
  const tbody = hwEl("tbody");
  tbody.appendChild(body);
  table.append(thead, tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function hardwareQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// ---- File download ----------------------------------------------------------
// Everything a page holds lives in this browser until the backend has storage, and site data can
// be cleared at any time, so both readings and curves have to be writable to a file. CSV is for
// reading and analysing, JSON for keeping a complete copy; either way the file carries full
// precision, not the display formatting above — it is the record, not the view.

function hwDownloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = hwEl("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function hwCsvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// CRLF and a UTF-8 BOM, both for Excel: without the BOM it decodes the file as the system
// codepage, which mangles any non-ASCII sample ID.
function hwDownloadCsv(filename, headers, rows) {
  const text = [headers, ...rows].map((row) => row.map(hwCsvCell).join(",")).join("\r\n");
  hwDownloadBlob(filename, new Blob([`﻿${text}\r\n`], { type: "text/csv;charset=utf-8" }));
}

function hwDownloadJson(filename, data) {
  hwDownloadBlob(filename, new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
}

// YYYYMMDD-HHMM in local time, to date a download's filename.
function hwFileStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// ---- Unmixing-basis note ---------------------------------------------------
// A basis version starting with "placeholder" means it hasn't been calibrated with an sfGFP
// standard yet: every place that shows fluorescence must carry this note. Pages place an
// element with data-basis-note, and this fills in the text; dynamically generated views
// build the element with hwBasisNote() and then call fillBasisNotes().

let hardwareBasisNotePromise = null;

function hardwareBasisNoteText() {
  if (!hardwareBasisNotePromise) {
    hardwareBasisNotePromise = HardwareApi.getUnmixBasis()
      .then((basis) => (String(basis.version).startsWith("placeholder")
        ? `Unmixing basis not yet calibrated (${basis.version}); the signal is the F4 channel alone.`
        : ""))
      .catch((err) => {
        hardwareBasisNotePromise = null;
        return `Unmixing basis unavailable: ${err.message}`;
      });
  }
  return hardwareBasisNotePromise;
}

function hwBasisNote(className = "sensor-stat-sub") {
  const el = hwEl("span", className);
  el.dataset.basisNote = "";
  el.hidden = true;
  return el;
}

async function fillBasisNotes(root = document) {
  const text = await hardwareBasisNoteText();
  for (const el of root.querySelectorAll("[data-basis-note]")) {
    el.textContent = text;
    el.hidden = !text;
  }
}

// ---- Browser-side scratch memory (just a convenience, not real data) ---------------------------

// v3: the step-by-step workflow; hardware_local.js clears the v2 keys.
const HARDWARE_LAST_PLAN_KEY = "lasreader.hardware.v3.lastPlanId";
const HARDWARE_LAST_BATCH_KEY = "lasreader.hardware.v3.lastBatchId";
// The data contract has no "last dark read time" field yet, so the frontend remembers it for now; switch to the API once the backend adds the field.
const HARDWARE_LAST_DARK_READ_KEY = "lasreader.hardware.v3.lastDarkReadUtc";
// When "Export everything" last produced a file in this browser. Only the Data page reads it, to
// say whether what is about to be deleted was ever backed up. Like the keys above it starts with
// "lasreader.", so a reset removes it along with everything else.
const HARDWARE_LAST_BACKUP_KEY = "lasreader.hardware.v3.lastBackupUtc";

function hardwareRemember(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    // Private browsing or disabled: just loses the "resume where I left off" convenience.
  }
}

function hardwareRecall(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

// ---- Step bar -----------------------------------------------------------------
// Each step shows its own state in a few words, and the first step that isn't done yet is marked
// as the next one, so the order of use is visible from every page. Every step stays a working
// link: a step that isn't ready says why rather than refusing to open (a past batch or a saved
// curve has to stay reachable with the instrument offline).

function renderHardwareSubnav() {
  const nav = document.getElementById("hardware-subnav");
  if (!nav) return;
  nav.className = "hw-steps";

  const list = hwEl("ol", "hw-steps-list");
  HARDWARE_STEPS.forEach((step, i) => {
    const item = hwEl("li", "hw-step");
    item.dataset.step = step.key;
    const link = hwEl("a");
    link.href = step.href;
    if (step.key === nav.dataset.page) link.setAttribute("aria-current", "step");
    const text = hwEl("span", "hw-step-text");
    text.append(hwEl("span", "hw-step-label", step.label), hwEl("span", "hw-step-state", "..."));
    link.append(hwEl("span", "hw-step-num", String(i + 1)), text);
    item.appendChild(link);
    list.appendChild(item);
  });

  const data = hwEl("a", "hw-data-link", HARDWARE_DATA_PAGE.label);
  data.href = HARDWARE_DATA_PAGE.href;
  if (nav.dataset.page === HARDWARE_DATA_PAGE.key) data.setAttribute("aria-current", "page");

  nav.append(list, data);
}

// [done, text, tone] per step. tone "attention" marks a step that is blocking the ones after it.
async function hardwareStepStates() {
  const [statusResult, signalResult, curvesResult, runsResult, batchesResult] = await Promise.allSettled([
    HardwareApi.getDeviceStatus(),
    HardwareApi.getCurrentSignal(),
    HardwareApi.listCurves(),
    HardwareApi.listCalibrationPlans(),
    HardwareApi.listBatches(),
  ]);
  const status = statusResult.status === "fulfilled" ? statusResult.value : null;
  const signal = signalResult.status === "fulfilled" ? signalResult.value : null;
  const curves = curvesResult.status === "fulfilled" ? curvesResult.value : [];
  const runs = runsResult.status === "fulfilled" ? runsResult.value : [];
  const batches = batchesResult.status === "fulfilled" ? batchesResult.value : [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const sensorFault = status && sensorReading(status.sensor_ok).tone === "error";
  const instrument = status
    ? [!sensorFault, sensorFault ? "Sensor fault" : `Online · ${status.config.fingerprint}`, sensorFault ? "attention" : null]
    : [false, "Offline", "attention"];

  const calibration = curves.length > 0
    ? [true, plural(runs.length, "run"), null]
    : [false, runs.length > 0 ? "No curve saved yet" : "Not started", null];

  const usable = status ? curves.filter((curve) => !curveBlockReason(curve, status.config.fingerprint, signal)).length : 0;
  let curvesState;
  if (curves.length === 0) curvesState = [false, "None yet", null];
  else if (!status) curvesState = [false, `${plural(curves.length, "curve")} · instrument offline`, null];
  else if (usable === 0) curvesState = [false, "None matches the instrument", "attention"];
  else curvesState = [true, `${usable} usable`, null];

  let measureText = "Needs a usable curve";
  if (batches.length > 0) measureText = `${batches.length} batch${batches.length === 1 ? "" : "es"}`;
  else if (usable > 0) measureText = "Ready";
  const measure = [false, measureText, null];
  return { instrument, calibration, curves: curvesState, measure };
}

async function refreshHardwareSteps() {
  const nav = document.getElementById("hardware-subnav");
  if (!nav) return;
  const states = await hardwareStepStates();
  const next = HARDWARE_STEPS.find((step) => !states[step.key][0])?.key ?? "measure";
  for (const item of nav.querySelectorAll(".hw-step")) {
    const [done, text, tone] = states[item.dataset.step];
    item.classList.toggle("is-done", done);
    item.classList.toggle("is-next", item.dataset.step === next);
    item.classList.toggle("is-attention", tone === "attention");
    item.querySelector(".hw-step-state").textContent = text;
    const label = item.querySelector(".hw-step-label").textContent;
    item.querySelector("a").setAttribute("aria-label",
      `Step ${HARDWARE_STEPS.findIndex((s) => s.key === item.dataset.step) + 1}, ${label}: ${text}${done ? ", done" : ""}${item.dataset.step === next ? ", next" : ""}`);
  }
}

// The link at the bottom of a page to the step after it.
function renderNextStep() {
  const el = document.getElementById("hardware-next");
  if (!el) return;
  const index = HARDWARE_STEPS.findIndex((step) => step.key === el.dataset.next);
  if (index < 0) return;
  const step = HARDWARE_STEPS[index];
  el.className = "hw-next";
  const link = hwEl("a", "hw-next-link");
  link.href = step.href;
  link.append(hwEl("span", "hw-next-label", "Next step"), hwEl("span", "hw-next-title", `${index + 1} · ${step.label}: ${step.next} →`));
  el.replaceChildren(link);
}

document.addEventListener("DOMContentLoaded", () => {
  renderHardwareSubnav();
  renderNextStep();
  refreshHardwareSteps();
  setInterval(refreshHardwareSteps, DEVICE_STATUS_POLL_INTERVAL_MS);
  fillBasisNotes();
});
