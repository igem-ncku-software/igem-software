// =========================================================
// swarming.html: Swarming Assay. Plate photos are sent to the backend one at a time, in order;
// for each it finds the plate (its known diameter gives the scale) and the colonies, and returns
// their sizes and the photo annotated. The detection is the team's notebook (iGEM_cv.ipynb),
// unchanged, in backend/app/swarming/; this page only uploads, shows and exports.
//
// POST /api/swarming/analyze (multipart: "file", and "dish_diameter_mm", 93 if left out) answers:
//   { dish: { x_px, y_px, radius_px, diameter_mm, method: "hough" | "contour" },
//     mm_per_px, mode: "normal" | "uv", purple_fraction,
//     threshold: { otsu, loose, core, uv_base, uv_peak, uv_thr } (the other mode's are null),
//     image: { width_px, height_px } (as analysed: a photo wider than 1200 px is shrunk to 1200 px
//       wide first, and every *_px and the annotated image are in its pixels),
//     original_image: { width_px, height_px } (as uploaded),
//     colonies: [{ index, feret_mm, eq_diameter_mm, area_mm2 }],
//     annotated_png: base64 PNG }
// and an error's `detail` is shown to the user verbatim. One photo per request: the backend runs
// one analysis at a time anyway, and a failed photo then costs only itself.
//
// One batch per page: date, incubation, notes and the plate diameter are shared; strain,
// condition and replicate belong to each photo. Nothing is stored: the CSV (every photo's
// colonies in one file) and the annotated PNGs are the record. Needs the backend, unlike the
// Plate Reader Assay, so a sleeping Render backend is said to be waking rather than broken.
// =========================================================

const SWARMING_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SWARMING_MAX_PHOTOS = 24;
// What OpenCV decodes and a browser can also show as the preview (not TIFF).
const SWARMING_TYPES = ["image/png", "image/jpeg", "image/webp"];
// Browsers ask before a page saves many files at once; a short gap keeps them in order.
const SWARMING_DOWNLOAD_GAP_MS = 350;

// One entry per photo, in the order added:
//   { id, file, strain, condition, replicate (text), replicateAuto (numbered by the page until typed),
//     state: "pending" | "analysing" | "done" | "failed", result, error, url (preview, lazy) }
let photos = [];
let nextPhotoId = 1;
let analyzing = false;
let exported = false;
let downloadingPngs = false;
const openDetails = new Set(); // photo ids whose detail row is open

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
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function experiment() {
  return {
    date: document.getElementById("info-date").value,
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

const replicateOk = (text) => /^[1-9]\d*$/.test(text.trim());
const groupKey = (strain, condition) => `${strain.trim().toLowerCase()}\u0000${condition.trim().toLowerCase()}`;
// Strain, condition and replicate together name a plate, so two photos can't share all three.
const plateKey = (p) => `${groupKey(p.strain, p.condition)}\u0000${Number(p.replicate)}`;
const photoNumber = (p) => photos.indexOf(p) + 1;
// "photo 3" / "photos 1, 2": which photos a problem is about.
const numbers = (list) => `${list.length === 1 ? "photo" : "photos"} ${list.map(photoNumber).join(", ")}`;

// Photos whose strain, condition and replicate are the same as an earlier photo's.
function duplicatePlates() {
  const seen = new Set();
  const dup = [];
  for (const p of photos) {
    if (!p.strain.trim() || !replicateOk(p.replicate)) continue;
    const key = plateKey(p);
    if (seen.has(key)) dup.push(p);
    else seen.add(key);
  }
  return dup;
}

// Every problem that holds Analyse (and the later steps), all at once.
function setupProblems() {
  const missing = [];
  if (!experiment().date) missing.push("date");
  if (!photos.length) missing.push("at least one photo");
  const noStrain = photos.filter((p) => !p.strain.trim());
  if (noStrain.length) missing.push(`strain for ${numbers(noStrain)}`);
  const wrong = [];
  if (dishDiameter() === null) wrong.push("plate diameter must be a number above 0");
  if (!incubationOk()) wrong.push("incubation must be a number of hours");
  const badRep = photos.filter((p) => !replicateOk(p.replicate));
  if (badRep.length) wrong.push(`replicate must be a whole number from 1 (${numbers(badRep)})`);
  const dup = duplicatePlates();
  if (dup.length) wrong.push(`same strain, condition and replicate as an earlier photo (${numbers(dup)})`);
  const parts = [];
  if (missing.length) parts.push(`Still needed: ${missing.join("; ")}.`);
  if (wrong.length) parts.push(`Check: ${wrong.join("; ")}.`);
  return parts.length ? parts.join(" ") : null;
}

const waitingForAnalysis = (p) => p.state === "pending" || p.state === "failed";
const analysed = () => photos.filter((p) => p.state === "done");
const allAnalysed = () => photos.length > 0 && photos.every((p) => p.state === "done");

// ---- Photos -------------------------------------------------------------------------------

// Numbers every replicate the user hasn't typed, in table order, within its strain and
// condition: the lowest number that group hasn't used. A typed replicate keeps its number and
// reserves it. A photo without a strain belongs to no group yet and is 1. Run after every
// change to strain, condition, replicate or the photo list, so a photo whose strain is changed
// starts at 1 in its new group instead of keeping its old number.
function renumberReplicates() {
  const used = new Map();
  const take = (p) => {
    const key = groupKey(p.strain, p.condition);
    if (!used.has(key)) used.set(key, new Set());
    return used.get(key);
  };
  for (const p of photos) {
    if (!p.replicateAuto && replicateOk(p.replicate)) take(p).add(Number(p.replicate));
  }
  for (const p of photos) {
    if (!p.replicateAuto) continue;
    if (!p.strain.trim()) {
      p.replicate = "1";
      continue;
    }
    const taken = take(p);
    let n = 1;
    while (taken.has(n)) n++;
    taken.add(n);
    p.replicate = String(n);
  }
}

function addPhotos(files) {
  const skipped = [];
  let added = 0;
  for (const file of files) {
    if (!SWARMING_TYPES.includes(file.type)) {
      skipped.push(`${file.name} (not a PNG, JPEG or WebP)`);
    } else if (file.size > SWARMING_MAX_UPLOAD_BYTES) {
      skipped.push(`${file.name} (${megabytes(file.size)}; the limit is 20 MB)`);
    } else if (photos.some((p) => p.file.name === file.name && p.file.size === file.size && p.file.lastModified === file.lastModified)) {
      skipped.push(`${file.name} (already added)`);
    } else if (photos.length >= SWARMING_MAX_PHOTOS) {
      skipped.push(`${file.name} (at most ${SWARMING_MAX_PHOTOS} photos per batch)`);
    } else {
      // A new photo starts blank, replicate 1; it is numbered once its strain is typed.
      photos.push({
        id: nextPhotoId++, file, strain: "", condition: "",
        replicate: "", replicateAuto: true,
        state: "pending", result: null, error: null, url: null,
      });
      added++;
    }
  }
  if (added) {
    renumberReplicates();
    exported = false;
  }
  const parts = [];
  if (added) parts.push(`Added ${plural(added, "photo", "photos")}.`);
  if (skipped.length) parts.push(`Skipped: ${skipped.join("; ")}.`);
  setStatus(document.getElementById("photo-status"), parts.join(" "), skipped.length ? "error" : "");
  renderPhotoTable();
  render();
}

function removePhoto(photo) {
  if (photo.state === "analysing") return;
  if (photo.url) URL.revokeObjectURL(photo.url);
  photos = photos.filter((p) => p !== photo);
  renumberReplicates();
  openDetails.delete(photo.id);
  exported = false;
  setStatus(document.getElementById("photo-status"), `Removed ${photo.file.name}.`);
  renderPhotoTable();
  render();
}

function photoStateText(p) {
  if (p.state === "pending") return "Not analysed";
  if (p.state === "analysing") return "Analysing…";
  if (p.state === "failed") return "Failed";
  return `Done · ${plural(p.result.colonies.length, "colony", "colonies")}`;
}

function photoStateTone(p) {
  if (p.state === "failed") return "error";
  if (p.state === "done") return p.result.colonies.length ? "ok" : "warn";
  return "";
}

// The photo table is rebuilt only when photos are added or removed, so typing keeps its focus;
// state cells and problem marks are updated in place by render().
function renderPhotoTable() {
  document.getElementById("photo-table-wrapper").hidden = photos.length === 0;
  document.getElementById("photo-body").replaceChildren(...photos.map((p, i) => {
    const tr = el("tr");
    tr.dataset.id = p.id;
    const name = el("td");
    name.append(el("span", null, p.file.name), el("span", "cell-sub", megabytes(p.file.size)));
    const input = (field, label, inputMode) => {
      const box = el("input", "table-input");
      box.type = "text";
      box.autocomplete = "off";
      if (inputMode) box.inputMode = inputMode;
      box.value = p[field];
      box.dataset.field = field;
      box.setAttribute("aria-label", `${label}, photo ${i + 1}`);
      box.addEventListener("input", () => {
        p[field] = box.value;
        if (field === "replicate") p.replicateAuto = false;
        renumberReplicates();
        exported = false; // these go into the CSV
        render();
      });
      const td = el("td");
      td.append(box);
      return td;
    };
    const remove = el("button", "btn-secondary table-button", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove photo ${i + 1}`);
    remove.addEventListener("click", () => removePhoto(p));
    const action = el("td", "action-cell");
    action.append(remove);
    tr.append(
      el("td", null, String(i + 1)),
      name,
      input("strain", "Strain"),
      input("condition", "Condition"),
      input("replicate", "Replicate", "numeric"),
      el("td", "photo-state"),
      action,
    );
    return tr;
  }));
}

function updatePhotoRows() {
  const dup = new Set(duplicatePlates());
  for (const tr of document.getElementById("photo-body").children) {
    const p = photos.find((x) => x.id === Number(tr.dataset.id));
    if (!p) continue;
    const state = tr.querySelector(".photo-state");
    state.replaceChildren(el("span", `flag-chip ${photoStateTone(p)}`.trim(), photoStateText(p)));
    if (p.state === "failed") state.append(el("span", "cell-sub is-error", p.error));
    const remove = tr.querySelector("button");
    remove.disabled = p.state === "analysing";
    remove.title = remove.disabled ? "Being analysed" : "";
    for (const box of tr.querySelectorAll("input")) {
      // A replicate the page renumbered; a typed value always equals p's already.
      if (box.dataset.field === "replicate" && box.value !== p.replicate) box.value = p.replicate;
      const bad = box.dataset.field === "strain" ? !p.strain.trim()
        : box.dataset.field === "replicate" ? !replicateOk(p.replicate) || dup.has(p)
        : false;
      box.classList.toggle("is-missing", bad);
      box.setAttribute("aria-invalid", String(bad));
    }
  }
}

// ---- Analysis -----------------------------------------------------------------------------

async function analyseOne(photo, diameter) {
  const body = new FormData();
  body.append("file", photo.file, photo.file.name);
  body.append("dish_diameter_mm", String(diameter));
  let res;
  try {
    res = await fetch(`${BACKEND_BASE_URL}/api/swarming/analyze`, { method: "POST", body });
  } catch {
    const error = new Error("Backend unreachable. Check the connection and try again.");
    error.unreachable = true;
    throw error;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`);
  return data;
}

// Analyses every photo not yet analysed (failed ones again), one at a time, in table order.
// Photos added meanwhile join the queue; a photo removed meanwhile is dropped. The diameter
// can't change during a run (its input is disabled), so every result shares one scale.
async function analyseAll() {
  if (setupProblems() || analyzing || !photos.some(waitingForAnalysis)) return;
  const status = document.getElementById("analyze-status");
  const diameter = dishDiameter();
  const tried = new Set();
  const next = () => photos.filter((p) => !tried.has(p) && waitingForAnalysis(p));
  analyzing = true;
  let stopped = null;
  for (let photo = next()[0]; photo; photo = next()[0]) {
    tried.add(photo);
    photo.state = "analysing";
    photo.error = null;
    const after = next().length;
    setStatus(status, `Analysing ${photo.file.name}${after ? ` (${after} more after it)` : ""}… a sleeping backend can take up to a minute to wake.`);
    render();
    try {
      photo.result = await analyseOne(photo, diameter);
      photo.state = "done";
      exported = false;
    } catch (err) {
      photo.state = "failed";
      photo.error = err.message;
      if (err.unreachable) {
        stopped = err.message; // every later photo would fail the same way
        break;
      }
    }
  }
  analyzing = false;
  const done = analysed();
  const failed = photos.filter((p) => p.state === "failed");
  const colonies = done.reduce((n, p) => n + p.result.colonies.length, 0);
  if (stopped) {
    setStatus(status, `Stopped: ${stopped} Analysed ${done.length} of ${photos.length}.`, "error");
  } else if (failed.length) {
    setStatus(status, `Analysed ${done.length} of ${photos.length}; ${numbers(failed)} failed. Analyse again to retry, or remove ${failed.length === 1 ? "it" : "them"}.`, "error");
  } else {
    setStatus(status, `Analysed ${plural(done.length, "photo", "photos")}: ${plural(colonies, "colony", "colonies")} found.`, "success");
  }
  render();
}

// ---- Detection ----------------------------------------------------------------------------

function photoLabel(p) {
  return [p.strain.trim(), p.condition.trim(), `rep ${p.replicate.trim()}`].filter(Boolean).join(" · ");
}

function simpleTable(className, headers, rows) {
  const table = el("table", className);
  if (headers) {
    const head = el("thead");
    const tr = el("tr");
    for (const h of headers) {
      const th = el("th", null, h);
      th.scope = "col";
      tr.append(th);
    }
    head.append(tr);
    table.append(head);
  }
  const body = el("tbody");
  body.append(...rows);
  table.append(body);
  const wrap = el("div", "table-wrapper");
  wrap.append(table);
  return wrap;
}

const MODE_TEXT = { normal: "Normal", uv: "UV" };

// The thresholds of the mode that ran, as the notebook labelled them.
// The upload's size; a backend from before the shrink to 1200 px analysed the photo as uploaded.
function originalSize(r) {
  return r.original_image ?? r.image;
}

function thresholdText(r) {
  const t = r.threshold;
  return r.mode === "uv"
    ? `G/B base ${fmt(t.uv_base, 2)}, peak ${fmt(t.uv_peak, 2)}, threshold ${fmt(t.uv_thr, 2)}`
    : `Otsu ${fmt(t.otsu, 0)}, loose ${fmt(t.loose, 0)}, core ${fmt(t.core, 0)}`;
}

// One photo opened: the photo and the detection side by side, then its plate and colonies.
function detailRow(p) {
  const r = p.result;
  const tr = el("tr", "detail-row");
  const td = el("td");
  td.colSpan = 8;

  if (!p.url) p.url = URL.createObjectURL(p.file);
  const images = el("div", "swarm-images");
  const figure = (src, alt, caption) => {
    const f = el("figure");
    const img = el("img");
    img.alt = alt;
    img.src = src;
    f.append(img, el("figcaption", null, caption));
    return f;
  };
  images.append(
    figure(p.url, `Photo ${photoNumber(p)} as uploaded`, "Photo"),
    figure(`data:image/png;base64,${r.annotated_png}`, `Photo ${photoNumber(p)} with the detected plate edge and colonies outlined`,
      "Detected: plate edge (green), colony outline (yellow), longest span and 10 mm scale bar (red)"),
  );
  td.append(images);

  if (r.dish.method !== "hough") {
    td.append(el("p", "status-message error",
      "Circle detection found no plate, so the fallback circle was used. Check the green circle matches the plate edge before using these sizes."));
  }

  td.append(el("h3", "detail-heading", "Plate"));
  td.append(simpleTable("kv-table", null, [
    ["Diameter (entered)", `${r.dish.diameter_mm} mm`],
    ["Found by", r.dish.method === "hough" ? "Circle detection" : "Fallback: largest bright region"],
    ["Centre", `(${r.dish.x_px}, ${r.dish.y_px}) px`],
    ["Radius", `${r.dish.radius_px} px`],
    ["Scale", `${fmt(r.mm_per_px, 4)} mm/px`],
    ["Mode", MODE_TEXT[r.mode]],
    ["Blue-purple share", `${fmt(r.purple_fraction * 100, 1)} % (UV above 35 %)`],
    ["Thresholds", thresholdText(r)],
    ["Photo", `${originalSize(r).width_px} × ${originalSize(r).height_px} px`],
    ["Analysed at", `${r.image.width_px} × ${r.image.height_px} px`],
  ].map(([key, value]) => {
    const row = el("tr");
    const th = el("th", null, key);
    th.scope = "row";
    row.append(th, el("td", null, value));
    return row;
  })));

  td.append(el("h3", "detail-heading", "Colonies"));
  if (r.colonies.length) {
    td.append(simpleTable(null, ["#", "Longest span", "Equivalent diameter", "Area"], r.colonies.map((c) => {
      const row = el("tr");
      row.append(
        el("td", null, `#${c.index}`),
        el("td", null, `${fmt(c.feret_mm, 2)} mm`),
        el("td", null, `${fmt(c.eq_diameter_mm, 2)} mm`),
        el("td", null, `${fmt(c.area_mm2, 1)} mm²`),
      );
      return row;
    })));
  } else {
    td.append(el("p", "plan-meta", "No colony found."));
  }

  const buttons = el("div", "button-row");
  const png = el("button", "btn-secondary", "Export this annotated photo (PNG)");
  png.type = "button";
  png.addEventListener("click", () => {
    downloadAnnotated(p);
    setStatus(document.getElementById("export-status"), `Exported ${annotatedName(p)}.`, "success");
  });
  buttons.append(png);
  td.append(buttons);

  tr.append(td);
  return tr;
}

// Rebuilt only when what it shows changed (results, labels, open rows), so an open photo
// isn't reloaded on every keystroke.
let renderedDetection = "";

function renderDetection() {
  const done = analysed();
  const signature = JSON.stringify(done.map((p) => [p.id, photoNumber(p), photoLabel(p), openDetails.has(p.id), p.result.mm_per_px]));
  if (signature === renderedDetection) return;
  renderedDetection = signature;

  const fallback = done.filter((p) => p.result.dish.method !== "hough");
  const warning = document.getElementById("dish-warning");
  warning.hidden = fallback.length === 0;
  warning.textContent = fallback.length
    ? `${numbers(fallback).replace(/^p/, "P")}: circle detection found no plate, so the fallback circle was used. View ${fallback.length === 1 ? "it" : "each"} and check the green circle matches the plate edge before using these sizes.`
    : "";

  const rows = [];
  for (const p of done) {
    const r = p.result;
    const open = openDetails.has(p.id);
    const largest = Math.max(...r.colonies.map((c) => c.feret_mm));
    const plate = el("td");
    plate.append(el("span", `flag-chip ${r.dish.method === "hough" ? "ok" : "warn"}`, r.dish.method === "hough" ? "Circle" : "Fallback"));
    const view = el("button", "btn-secondary table-button", open ? "Hide" : "View");
    view.type = "button";
    view.setAttribute("aria-expanded", String(open));
    view.setAttribute("aria-label", `${open ? "Hide" : "View"} photo ${photoNumber(p)}`);
    view.addEventListener("click", () => {
      if (open) openDetails.delete(p.id);
      else openDetails.add(p.id);
      render();
    });
    const action = el("td", "action-cell");
    action.append(view);
    const tr = el("tr");
    tr.append(
      el("td", null, String(photoNumber(p))),
      el("td", null, p.file.name),
      el("td", null, photoLabel(p)),
      plate,
      el("td", null, MODE_TEXT[r.mode]),
      el("td", null, String(r.colonies.length)),
      el("td", null, r.colonies.length ? `${fmt(largest, 2)} mm` : "--"),
      action,
    );
    rows.push(tr);
    if (open) rows.push(detailRow(p));
  }
  document.getElementById("result-body").replaceChildren(...rows);
}

// ---- Export -------------------------------------------------------------------------------

const safe = (text) => text.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");

function annotatedName(p) {
  const parts = [`swarming-${experiment().date}`, String(photoNumber(p)).padStart(2, "0"), safe(p.strain), safe(p.condition), `r${p.replicate.trim()}`];
  return `${parts.filter(Boolean).join("-")}.png`;
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

function downloadAnnotated(p) {
  const bytes = Uint8Array.from(atob(p.result.annotated_png), (ch) => ch.charCodeAt(0));
  downloadBlob(annotatedName(p), new Blob([bytes], { type: "image/png" }));
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADERS = [
  "date", "strain", "condition", "replicate", "incubation_h", "notes",
  "photo_number", "photo", "photo_width_px", "photo_height_px", "analysed_width_px", "analysed_height_px",
  "dish_diameter_mm", "dish_found_by", "dish_x_px", "dish_y_px", "dish_radius_px", "mm_per_px",
  "mode", "purple_fraction", "otsu_threshold", "loose_threshold", "core_threshold", "uv_base", "uv_peak", "uv_threshold",
  "colony", "feret_mm", "eq_diameter_mm", "area_mm2",
];

// One row per colony, every photo in table order (one empty-colony row for a photo with none);
// full precision.
function exportCsv() {
  const info = experiment();
  const rows = [];
  for (const p of photos) {
    const r = p.result;
    const d = r.dish;
    const base = [
      info.date, p.strain.trim(), p.condition.trim(), Number(p.replicate), info.incubation, info.notes,
      photoNumber(p), p.file.name, originalSize(r).width_px, originalSize(r).height_px,
      r.image.width_px, r.image.height_px,
      d.diameter_mm, d.method, d.x_px, d.y_px, d.radius_px, r.mm_per_px,
      r.mode, r.purple_fraction, r.threshold.otsu, r.threshold.loose, r.threshold.core,
      r.threshold.uv_base, r.threshold.uv_peak, r.threshold.uv_thr,
    ];
    const colonies = r.colonies.length ? r.colonies : [null];
    for (const c of colonies) rows.push([...base, c?.index, c?.feret_mm, c?.eq_diameter_mm, c?.area_mm2]);
  }
  const text = [CSV_HEADERS, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const name = `swarming-${info.date}.csv`;
  downloadBlob(name, new Blob([`﻿${text}\r\n`], { type: "text/csv;charset=utf-8" }));
  exported = true;
  setStatus(document.getElementById("export-status"), `Exported ${name}: ${plural(photos.length, "photo", "photos")}, ${plural(rows.length, "row", "rows")}.`, "success");
  render();
}

async function exportPngs() {
  if (downloadingPngs) return;
  downloadingPngs = true;
  render();
  const status = document.getElementById("export-status");
  const list = photos.slice();
  for (let i = 0; i < list.length; i++) {
    setStatus(status, `Saving annotated photo ${i + 1} of ${list.length}…`);
    downloadAnnotated(list[i]);
    await new Promise((resolve) => setTimeout(resolve, SWARMING_DOWNLOAD_GAP_MS));
  }
  downloadingPngs = false;
  setStatus(status, `Exported ${plural(list.length, "annotated photo", "annotated photos")} (PNG). If the browser blocked some, allow multiple downloads and export again.`, "success");
  render();
}

// ---- Rendering ----------------------------------------------------------------------------

function render() {
  const problems = setupProblems();
  const pending = photos.filter(waitingForAnalysis).length;
  const button = document.getElementById("analyze-button");
  button.textContent = pending ? `Analyse ${plural(pending, "photo", "photos")}` : "Analyse";
  setBlocked(button, document.getElementById("analyze-reason"),
    analyzing ? "Analysing…"
      : problems ?? (pending ? null : "Every photo is analysed. Add photos to analyse more."));
  document.getElementById("info-date").setAttribute("aria-invalid", String(!experiment().date));
  const diameter = document.getElementById("dish-diameter");
  diameter.setAttribute("aria-invalid", String(dishDiameter() === null));
  diameter.disabled = analyzing;
  diameter.title = analyzing ? "Can't change while photos are being analysed" : "";
  document.getElementById("info-incubation").setAttribute("aria-invalid", String(!incubationOk()));
  updatePhotoRows();

  // Step 1 incomplete holds every later step, even with results.
  const all = allAnalysed();
  const any = analysed().length > 0;
  const waitFor = problems ? "Complete step 1 first." : "Analyse the photos first.";
  setStepCard(document.getElementById("photo-card"), all && !problems ? "done" : "current");
  setStepCard(document.getElementById("detect-card"), problems || !any ? "waiting" : all ? "done" : "current", waitFor);
  setStepCard(document.getElementById("export-card"), !problems && all ? (exported ? "done" : "current") : "waiting",
    problems || !any ? waitFor : "Export waits until every photo is analysed. Analyse again, or remove a photo that can't be.");
  if (!problems && any) renderDetection();
  const png = document.getElementById("export-png");
  png.disabled = downloadingPngs;
  png.textContent = `Export annotated photos (${plural(photos.length, "PNG", "PNGs")})`;
}

document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("photo-file");
  fileInput.addEventListener("change", () => {
    addPhotos(Array.from(fileInput.files));
    fileInput.value = ""; // so a photo removed by mistake can be chosen again
  });
  for (const id of ["info-date", "info-incubation", "info-notes"]) {
    // The fields go into the CSV, so a change after an export needs another.
    document.getElementById(id).addEventListener("input", () => {
      exported = false;
      render();
    });
  }
  // The diameter sets every size, so results measured with another one are discarded.
  document.getElementById("dish-diameter").addEventListener("input", () => {
    const had = photos.some((p) => p.state !== "pending");
    for (const p of photos) {
      p.state = "pending";
      p.result = null;
      p.error = null;
    }
    openDetails.clear();
    renderedDetection = "";
    if (had) {
      exported = false;
      setStatus(document.getElementById("analyze-status"), "Plate diameter changed. Analyse again.");
      setStatus(document.getElementById("export-status"), "");
    }
    render();
  });
  document.getElementById("analyze-button").addEventListener("click", analyseAll);
  document.getElementById("export-csv").addEventListener("click", exportCsv);
  document.getElementById("export-png").addEventListener("click", exportPngs);
  window.addEventListener("beforeunload", (event) => {
    if (!analysed().length || exported) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // A reload can keep the chosen files in the input; start from them rather than a blank page.
  if (fileInput.files.length) {
    addPhotos(Array.from(fileInput.files));
    fileInput.value = "";
  }
  renderPhotoTable();
  render();
});
