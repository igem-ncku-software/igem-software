// =========================================================
// swarming.html: Swarming Assay. One plate photo is sent to the backend, which finds the plate
// (its known 93 mm diameter gives the scale) and the colony, and returns the colony's size and
// the photo annotated. The detection is the team's notebook (iGEM_cv.ipynb), unchanged, in
// backend/app/swarming/; this page only uploads, shows and exports.
//
// POST /api/swarming/analyze (multipart: "file", and "dish_diameter_mm", 93 if left out) answers:
//   { dish: { x_px, y_px, radius_px, diameter_mm, method: "hough" | "contour" },
//     mm_per_px, image: { width_px, height_px },
//     colonies: [{ index, feret_mm, eq_diameter_mm, area_mm2 }],
//     annotated_png: base64 PNG }
// and an error's `detail` is shown to the user verbatim.
//
// Nothing is stored: the CSV and the annotated PNG are the record. Needs the backend, unlike the
// Plate Reader Assay, so a sleeping Render backend is said to be waking rather than broken.
// =========================================================

const SWARMING_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// What OpenCV decodes and a browser can also show as the preview (not TIFF).
const SWARMING_TYPES = ["image/png", "image/jpeg", "image/webp", "image/bmp"];

let photo = null;      // the chosen File
let photoUrl = null;   // its object URL, for the preview
let result = null;     // the backend's answer for this photo
let analyzing = false;
let exported = false;

// ---- Small helpers ------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function setStatus(node, text, kind) {
  node.textContent = text;
  node.className = "status-message" + (kind ? ` ${kind}` : "");
}

function setBlocked(button, reasonEl, reason) {
  button.disabled = Boolean(reason);
  button.classList.toggle("is-blocked", Boolean(reason));
  reasonEl.textContent = reason || "";
  reasonEl.hidden = !reason;
}

const STEP_CARD_CHIP = { done: ["Done", "ok"], current: ["Now", "warn"], waiting: ["Waiting", ""] };

function setStepCard(card, state, waitingReason = null) {
  card.dataset.state = state;
  const [text, tone] = STEP_CARD_CHIP[state];
  const chip = card.querySelector(".step-card-state");
  chip.textContent = text;
  chip.className = `flag-chip step-card-state ${tone}`.trim();
  card.querySelector(".step-card-body").hidden = state === "waiting";
  const reason = card.querySelector(".step-card-waiting");
  reason.textContent = state === "waiting" ? waitingReason ?? "" : "";
  reason.hidden = state !== "waiting" || !waitingReason;
}

const fmt = (value, dp) => (Number.isFinite(value) ? value.toFixed(dp) : "--");

function experiment() {
  return {
    date: document.getElementById("info-date").value,
    strain: document.getElementById("info-strain").value.trim(),
    condition: document.getElementById("info-condition").value.trim(),
    incubation: document.getElementById("info-incubation").value.trim(),
    notes: document.getElementById("info-notes").value.trim(),
  };
}

// A positive number, or null. Plain decimals only, like the other pages' inputs.
function positiveNumber(text) {
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(text)) return null;
  const value = Number(text);
  return value > 0 ? value : null;
}

function dishDiameter() {
  return positiveNumber(document.getElementById("dish-diameter").value.trim());
}

// Optional, but if given it must be a number: it goes into the CSV.
function incubationOk() {
  const text = experiment().incubation;
  return text === "" || /^\d+(\.\d*)?$|^\.\d+$/.test(text);
}

// What still holds Analyse, all at once.
function analyzeProblems() {
  const info = experiment();
  const missing = [];
  if (!info.date) missing.push("date");
  if (!info.strain) missing.push("strain");
  if (!photo) missing.push("photo");
  const wrong = [];
  if (dishDiameter() === null) wrong.push("plate diameter must be a number above 0");
  if (!incubationOk()) wrong.push("incubation must be a number of hours");
  const parts = [];
  if (missing.length) parts.push(`Still needed: ${missing.join(", ")}.`);
  if (wrong.length) parts.push(`Check: ${wrong.join("; ")}.`);
  return parts.length ? parts.join(" ") : null;
}

// ---- Photo --------------------------------------------------------------------------------

function choosePhoto(input) {
  const status = document.getElementById("photo-status");
  const file = input.files[0] ?? null;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photo = null;
  photoUrl = null;
  result = null;
  exported = false;
  setStatus(document.getElementById("analyze-status"), "");
  setStatus(document.getElementById("export-status"), "");
  if (file && !SWARMING_TYPES.includes(file.type)) {
    setStatus(status, `${file.name} is not a PNG or JPEG.`, "error");
  } else if (file && file.size > SWARMING_MAX_UPLOAD_BYTES) {
    setStatus(status, `${file.name} is ${(file.size / 1048576).toFixed(1)} MB; the limit is 20 MB.`, "error");
  } else if (file) {
    photo = file;
    photoUrl = URL.createObjectURL(file);
    setStatus(status, `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`);
  } else {
    setStatus(status, "");
  }
  render();
}

async function analyze() {
  if (analyzeProblems() || analyzing) return;
  const status = document.getElementById("analyze-status");
  const sent = photo;
  analyzing = true;
  render();
  setStatus(status, "Analysing… a sleeping backend can take up to a minute to wake.");
  try {
    const body = new FormData();
    body.append("file", sent, sent.name);
    body.append("dish_diameter_mm", String(dishDiameter()));
    let res;
    try {
      res = await fetch(`${BACKEND_BASE_URL}/api/swarming/analyze`, { method: "POST", body });
    } catch {
      throw new Error("Backend unreachable. Check the connection and try again.");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`;
      throw new Error(detail);
    }
    if (sent !== photo) return; // another photo was chosen meanwhile
    result = data;
    exported = false;
    const n = result.colonies.length;
    setStatus(status, n ? `Found ${n} ${n === 1 ? "colony" : "colonies"}.` : "No colony found.", n ? "success" : "error");
  } catch (err) {
    if (sent === photo) setStatus(status, `Analysis failed: ${err.message}`, "error");
  } finally {
    analyzing = false;
    render();
  }
}

// ---- Detection ----------------------------------------------------------------------------

let renderedResult = null;

function renderDetection() {
  if (renderedResult === result) return; // only the experiment fields changed
  renderedResult = result;
  document.getElementById("photo-original").src = photoUrl;
  document.getElementById("photo-annotated").src = `data:image/png;base64,${result.annotated_png}`;

  const dish = result.dish;
  document.getElementById("dish-warning").hidden = dish.method === "hough";
  const rows = [
    ["Diameter (entered)", `${dish.diameter_mm} mm`],
    ["Found by", dish.method === "hough" ? "Circle detection" : "Fallback: largest bright region"],
    ["Centre", `(${dish.x_px}, ${dish.y_px}) px`],
    ["Radius", `${dish.radius_px} px`],
    ["Scale", `${fmt(result.mm_per_px, 4)} mm/px`],
    ["Photo", `${result.image.width_px} × ${result.image.height_px} px`],
  ];
  const dishBody = document.getElementById("dish-body");
  dishBody.replaceChildren(...rows.map(([key, value]) => {
    const tr = el("tr");
    tr.append(el("th", null, key), el("td", null, value));
    tr.firstChild.scope = "row";
    return tr;
  }));

  const colonies = result.colonies;
  document.getElementById("colony-table-wrapper").hidden = colonies.length === 0;
  document.getElementById("colony-empty").hidden = colonies.length > 0;
  document.getElementById("colony-body").replaceChildren(...colonies.map((c) => {
    const tr = el("tr");
    tr.append(
      el("td", null, `#${c.index}`),
      el("td", null, `${fmt(c.feret_mm, 2)} mm`),
      el("td", null, `${fmt(c.eq_diameter_mm, 2)} mm`),
      el("td", null, `${fmt(c.area_mm2, 1)} mm²`),
    );
    return tr;
  }));
}

// ---- Export -------------------------------------------------------------------------------

function fileStem() {
  const info = experiment();
  const strain = info.strain.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return `swarming-${info.date}${strain ? `-${strain}` : ""}`;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADERS = [
  "date", "strain", "condition", "incubation_h", "notes", "photo", "photo_width_px", "photo_height_px",
  "dish_diameter_mm", "dish_found_by", "dish_x_px", "dish_y_px", "dish_radius_px", "mm_per_px",
  "colony", "feret_mm", "eq_diameter_mm", "area_mm2",
];

// One row per colony (one empty-colony row when none was found); full precision.
function exportCsv() {
  const info = experiment();
  const d = result.dish;
  const base = [
    info.date, info.strain, info.condition, info.incubation, info.notes, photo.name, result.image.width_px, result.image.height_px,
    d.diameter_mm, d.method, d.x_px, d.y_px, d.radius_px, result.mm_per_px,
  ];
  const colonies = result.colonies.length ? result.colonies : [null];
  const rows = colonies.map((c) => [...base, c?.index, c?.feret_mm, c?.eq_diameter_mm, c?.area_mm2]);
  const text = [CSV_HEADERS, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const name = `${fileStem()}.csv`;
  downloadBlob(name, new Blob([`﻿${text}\r\n`], { type: "text/csv;charset=utf-8" }));
  exported = true;
  setStatus(document.getElementById("export-status"), `Exported ${name}.`, "success");
  render();
}

function exportPng() {
  const bytes = Uint8Array.from(atob(result.annotated_png), (ch) => ch.charCodeAt(0));
  const name = `${fileStem()}.png`;
  downloadBlob(name, new Blob([bytes], { type: "image/png" }));
  setStatus(document.getElementById("export-status"), `Exported ${name}.`, "success");
}

// ---- Rendering ----------------------------------------------------------------------------

function render() {
  const problems = analyzeProblems();
  setBlocked(document.getElementById("analyze-button"), document.getElementById("analyze-reason"),
    analyzing ? "Analysing…" : problems ?? (result ? "Already analysed. Choose another photo to analyse again." : null));
  for (const id of ["info-date", "info-strain"]) {
    const input = document.getElementById(id);
    input.setAttribute("aria-invalid", String(!input.value.trim()));
  }
  document.getElementById("dish-diameter").setAttribute("aria-invalid", String(dishDiameter() === null));
  document.getElementById("info-incubation").setAttribute("aria-invalid", String(!incubationOk()));

  // Step 1 incomplete holds every later step, even with a result.
  const ready = Boolean(result) && !problems;
  const waitFor = problems ? "Complete step 1 first." : "Analyse a photo first.";
  setStepCard(document.getElementById("photo-card"), ready ? "done" : "current");
  setStepCard(document.getElementById("detect-card"), ready ? "done" : "waiting", waitFor);
  setStepCard(document.getElementById("export-card"), ready ? (exported ? "done" : "current") : "waiting", waitFor);
  if (ready) renderDetection();
}

document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("photo-file");
  fileInput.addEventListener("change", () => choosePhoto(fileInput));
  for (const id of ["info-date", "info-strain", "info-condition", "info-incubation", "info-notes"]) {
    // The fields go into the CSV, so a change after an export needs another.
    document.getElementById(id).addEventListener("input", () => {
      exported = false;
      render();
    });
  }
  // The diameter sets every size, so a result measured with another one is discarded.
  document.getElementById("dish-diameter").addEventListener("input", () => {
    if (result) {
      result = null;
      exported = false;
      setStatus(document.getElementById("analyze-status"), "Plate diameter changed. Analyse again.");
      setStatus(document.getElementById("export-status"), "");
    }
    render();
  });
  document.getElementById("analyze-button").addEventListener("click", analyze);
  document.getElementById("export-csv").addEventListener("click", exportCsv);
  document.getElementById("export-png").addEventListener("click", exportPng);
  window.addEventListener("beforeunload", (event) => {
    if (!result || exported) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // A reload can keep the chosen file in the input; start from it rather than a blank page.
  if (fileInput.files.length) choosePhoto(fileInput);
  render();
});
