// =========================================================
// plate-assay.html: import from a plate. Every plate reader can export or copy a read as an 8 x 12
// block (rows A-H, columns 1-12), so this is the input that fits any instrument: paste the
// fluorescence plate (and, with F/OD600, the OD plate), mark which wells are which, and fill the
// entry table. The table stays the one format everything else reads: after filling it can be
// edited like any typed table, and the fit, results and CSV don't know where it came from.
//
// Nothing here is stored. Loaded after js/plate_assay.js, whose globals it fills (rows, repCount,
// odMode, newRow, renderEntryTable, dataChanged, ...).
// =========================================================

const PLATE_ROW_LETTERS = "ABCDEFGH";
const PLATE_COLUMNS = 12;
const PLATE_WELLS = [...PLATE_ROW_LETTERS].flatMap((letter) =>
  Array.from({ length: PLATE_COLUMNS }, (_, c) => `${letter}${c + 1}`));

const plateValues = { f: null, od: null };  // well -> cell text as pasted ("" = empty well), or null before a paste
const plateMarks = new Map();               // well -> { role, key, dilution }
const plateSelection = new Set();
let plateAnchor = null;                     // the last well clicked, for Shift-click ranges

// ---- Parsing a pasted plate -------------------------------------------------------

// A pasted plate as a Map of well -> text, or throws with what's wrong. Accepts the block with or
// without its row letters and column numbers, tab-, comma- or space-separated.
function parsePlate(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");
  const split = (line) => {
    if (line.includes("\t")) return line.split("\t");
    if (line.includes(",")) return line.split(",");
    return line.trim().split(/\s+/);
  };
  const grid = lines.map((line) => split(line).map((cell) => cell.trim()));

  let body;
  const labelled = grid.filter((cells) => /^[A-H]$/i.test(cells[0]));
  if (labelled.length > 0) {
    const letters = labelled.map((cells) => cells[0].toUpperCase());
    if (labelled.length !== 8 || new Set(letters).size !== 8) {
      throw new Error(`Expected rows A–H once each; found ${letters.join(", ")}.`);
    }
    body = [...PLATE_ROW_LETTERS].map((letter) => labelled.find((cells) => cells[0].toUpperCase() === letter).slice(1));
  } else {
    // Without row letters, a line reading 1 2 ... 12 is the column header, not data.
    const isHeader = (cells) => {
      const filled = cells.filter((cell) => cell !== "");
      return filled.length === PLATE_COLUMNS && filled.every((cell, i) => cell === String(i + 1));
    };
    body = grid.filter((cells) => !isHeader(cells));
    if (body.length !== 8) throw new Error(`Expected 8 rows (A–H); found ${body.length}.`);
  }

  const values = new Map();
  body.forEach((cells, r) => {
    const row = [...cells];
    while (row.length > PLATE_COLUMNS && row[row.length - 1] === "") row.pop();
    if (row.length > PLATE_COLUMNS) throw new Error(`Row ${PLATE_ROW_LETTERS[r]} has ${row.length} values; a plate has 12 columns.`);
    for (let c = 0; c < PLATE_COLUMNS; c++) values.set(`${PLATE_ROW_LETTERS[r]}${c + 1}`, row[c] ?? "");
  });
  return values;
}

function readPlateInput(kind) {
  const text = document.getElementById(kind === "f" ? "plate-f" : "plate-od").value;
  if (text.trim() === "") {
    plateValues[kind] = null;
    return null;
  }
  try {
    plateValues[kind] = parsePlate(text);
    return null;
  } catch (err) {
    plateValues[kind] = null;
    return `${kind === "f" ? "Fluorescence" : "OD600"} plate: ${err.message}`;
  }
}

function renderParseStatus() {
  const problems = [readPlateInput("f"), odMode ? readPlateInput("od") : null].filter(Boolean);
  const statusEl = document.getElementById("plate-parse-status");
  if (problems.length) {
    setStatus(statusEl, problems.join(" "), "error");
  } else if (plateValues.f) {
    const read = (kind) => PLATE_WELLS.filter((well) => plateValues[kind]?.get(well) !== "").length;
    const od = odMode && plateValues.od ? `, OD600 ${read("od")}` : "";
    setStatus(statusEl, `Read ${plural(read("f"), "well")} of fluorescence${od}.`, "success");
  } else {
    setStatus(statusEl, "", null);
  }
}

// ---- The plate map ------------------------------------------------------------------

function markTag(mark) {
  if (!mark) return "";
  if (mark.role === "standard") return `${mark.key} nM`;
  if (mark.role === "medium") return "Medium";
  return mark.key;
}

function toggleWells(wells) {
  const all = wells.every((well) => plateSelection.has(well));
  for (const well of wells) {
    if (all) plateSelection.delete(well);
    else plateSelection.add(well);
  }
  renderPlate();
}

function wellRange(from, to) {
  const [r1, c1] = [PLATE_ROW_LETTERS.indexOf(from[0]), Number(from.slice(1))];
  const [r2, c2] = [PLATE_ROW_LETTERS.indexOf(to[0]), Number(to.slice(1))];
  return PLATE_WELLS.filter((well) => {
    const r = PLATE_ROW_LETTERS.indexOf(well[0]);
    const c = Number(well.slice(1));
    return r >= Math.min(r1, r2) && r <= Math.max(r1, r2) && c >= Math.min(c1, c2) && c <= Math.max(c1, c2);
  });
}

function clickWell(well, event) {
  if (event.shiftKey && plateAnchor) {
    for (const w of wellRange(plateAnchor, well)) plateSelection.add(w);
  } else if (plateSelection.has(well)) {
    plateSelection.delete(well);
  } else {
    plateSelection.add(well);
  }
  plateAnchor = well;
  renderPlate();
}

function headerButton(text, label, onClick) {
  const button = el("button", "plate-head", text);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function renderPlate() {
  const table = document.getElementById("plate-grid");
  const head = el("tr");
  const corner = el("th");
  corner.appendChild(headerButton("All", "Select all wells", () => toggleWells(PLATE_WELLS)));
  head.appendChild(corner);
  for (let c = 1; c <= PLATE_COLUMNS; c++) {
    const th = el("th");
    th.scope = "col";
    th.appendChild(headerButton(String(c), `Select column ${c}`,
      () => toggleWells(PLATE_WELLS.filter((well) => Number(well.slice(1)) === c))));
    head.appendChild(th);
  }
  const thead = el("thead");
  thead.appendChild(head);

  const tbody = el("tbody");
  for (const letter of PLATE_ROW_LETTERS) {
    const tr = el("tr");
    const th = el("th");
    th.scope = "row";
    th.appendChild(headerButton(letter, `Select row ${letter}`,
      () => toggleWells(PLATE_WELLS.filter((well) => well[0] === letter))));
    tr.appendChild(th);
    for (let c = 1; c <= PLATE_COLUMNS; c++) {
      const well = `${letter}${c}`;
      const mark = plateMarks.get(well);
      const text = plateValues.f?.get(well) ?? "";
      const invalid = text !== "" && !Number.isFinite(parseNumber(text));

      const button = el("button", `plate-well${mark ? ` is-${mark.role}` : ""}${plateSelection.has(well) ? " is-selected" : ""}`);
      button.type = "button";
      button.setAttribute("aria-pressed", String(plateSelection.has(well)));
      button.setAttribute("aria-label", `${well}${mark ? `, ${markTag(mark)}` : ", not marked"}${text ? `, ${text}` : ""}`);
      button.append(
        el("span", "plate-well-tag", markTag(mark) || well),
        el("span", `plate-well-value${invalid ? " is-invalid" : ""}`, text === "" ? "" : invalid ? text : formatSignal(parseNumber(text))),
      );
      button.addEventListener("click", (event) => clickWell(well, event));
      const td = el("td");
      td.appendChild(button);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.replaceChildren(thead, tbody);
  renderMarkControls();
  renderFillControls();
}

// ---- Marking wells ------------------------------------------------------------------

function markRole() {
  return document.getElementById("plate-role").value;
}

function markProblem() {
  if (plateSelection.size === 0) return "Select wells first: click a well, Shift-click for a range, or a row or column header.";
  const role = markRole();
  if (role === "standard" && !(parseNumber(document.getElementById("plate-conc").value) >= 0)) {
    return "Enter the concentration, a number ≥ 0 (0 for blanks).";
  }
  if (role === "sample") {
    if (!document.getElementById("plate-name").value.trim()) return "Enter the sample name.";
    if (!(parseNumber(document.getElementById("plate-dilution").value) >= 1)) return "Dilution must be a number ≥ 1.";
  }
  return null;
}

function renderMarkControls() {
  const role = markRole();
  document.getElementById("plate-conc-field").hidden = role !== "standard";
  document.getElementById("plate-name-field").hidden = role !== "sample";
  document.getElementById("plate-dilution-field").hidden = role !== "sample";
  const mediumOption = document.querySelector('#plate-role option[value="medium"]');
  mediumOption.hidden = !odMode;
  mediumOption.disabled = !odMode;
  if (!odMode && role === "medium") document.getElementById("plate-role").value = "standard";

  const button = document.getElementById("plate-mark-button");
  button.textContent = role === "clear" ? `Clear ${plural(plateSelection.size, "well")}` : `Mark ${plural(plateSelection.size, "well")}`;
  setBlocked(button, document.getElementById("plate-mark-reason"), markProblem());
}

function markSelection() {
  const role = markRole();
  for (const well of plateSelection) {
    if (role === "clear") plateMarks.delete(well);
    else if (role === "standard") plateMarks.set(well, { role, key: String(parseNumber(document.getElementById("plate-conc").value)), dilution: "1" });
    else if (role === "sample") {
      plateMarks.set(well, {
        role,
        key: document.getElementById("plate-name").value.trim(),
        dilution: String(parseNumber(document.getElementById("plate-dilution").value)),
      });
    } else plateMarks.set(well, { role, key: "", dilution: "1" });
  }
  plateSelection.clear();
  plateAnchor = null;
  renderPlate();
}

// ---- Filling the table ---------------------------------------------------------------

// The marked wells grouped as table rows: blanks and standards by concentration, samples by name,
// the medium blank as one row. Each group's wells in plate order (A1, A2, ... H12).
function plateGroups() {
  const groups = new Map();
  for (const well of PLATE_WELLS) {
    const mark = plateMarks.get(well);
    if (!mark) continue;
    const id = mark.role === "standard" ? `standard:${Number(mark.key)}`
      : mark.role === "sample" ? `sample:${mark.key.toLowerCase()}` : "medium";
    if (!groups.has(id)) groups.set(id, { ...mark, wells: [] });
    groups.get(id).wells.push(well);
  }
  const order = { medium: 0, standard: 1, sample: 2 };
  return [...groups.values()].sort((a, b) => order[a.role] - order[b.role]
    || (a.role === "standard" ? Number(a.key) - Number(b.key) : 0));
}

function wellList(wells) {
  return wells.length > 6 ? `${wells.slice(0, 6).join(", ")} and ${wells.length - 6} more` : wells.join(", ");
}

// Every reason Fill can't run, at once.
function fillProblems() {
  const problems = [];
  if (!plateValues.f) problems.push("Paste the fluorescence plate.");
  if (odMode && !plateValues.od) problems.push("Paste the OD600 plate.");
  if (plateMarks.size === 0) problems.push("Mark the wells.");
  if (problems.length) return problems;

  const marked = PLATE_WELLS.filter((well) => plateMarks.has(well));
  for (const [kind, name] of odMode ? [["f", "fluorescence"], ["od", "OD600"]] : [["f", "fluorescence"]]) {
    const empty = marked.filter((well) => plateValues[kind].get(well) === "");
    const notNumber = marked.filter((well) => plateValues[kind].get(well) !== "" && !Number.isFinite(parseNumber(plateValues[kind].get(well))));
    if (empty.length) problems.push(`No ${name} value in marked ${plural(empty.length, "well")}: ${wellList(empty)}.`);
    if (notNumber.length) problems.push(`${name[0].toUpperCase()}${name.slice(1)} isn't a number in ${wellList(notNumber)}.`);
  }
  if (!odMode && marked.some((well) => plateMarks.get(well).role === "medium")) {
    problems.push("Medium blank wells need Fluorescence ÷ OD600.");
  }
  const dilutions = new Map();
  for (const well of marked) {
    const mark = plateMarks.get(well);
    if (mark.role !== "sample") continue;
    const name = mark.key.toLowerCase();
    if (dilutions.has(name) && dilutions.get(name) !== mark.dilution) problems.push(`Sample ${mark.key} is marked with two dilutions.`);
    dilutions.set(name, mark.dilution);
  }
  for (const group of plateGroups()) {
    if (group.wells.length > ASSAY_MAX_REPS) {
      problems.push(`${markTag(group)} has ${group.wells.length} wells; at most ${ASSAY_MAX_REPS} replicates.`);
    }
  }
  return [...new Set(problems)];
}

function renderFillControls() {
  const marked = plateMarks.size;
  document.getElementById("plate-marked").textContent =
    `${plural(marked, "well")} marked in ${plural(plateGroups().length, "group")}.`;
  setBlocked(document.getElementById("plate-fill-button"), document.getElementById("plate-fill-reason"), fillProblems().join(" "));
}

// Replaces the entry table with one row per group, its wells as the replicates.
function fillTableFromPlate() {
  const groups = plateGroups();
  repCount = Math.max(ASSAY_MIN_REPS, ...groups.map((g) => g.wells.length));
  rows.length = 0;
  for (const group of groups) {
    const row = newRow(group.role);
    row.key = group.key;
    row.dilution = group.dilution;
    group.wells.forEach((well, rep) => {
      row.reps[rep] = plateValues.f.get(well);
      if (odMode) row.ods[rep] = plateValues.od.get(well);
      row.wells[rep] = well;
    });
    rows.push(row);
  }
  exclusions.clear();
  renderEntryTable();
  dataChanged(true);
  const wells = groups.reduce((n, g) => n + g.wells.length, 0);
  setStatus(document.getElementById("plate-fill-status"),
    `Table filled: ${plural(rows.length, "row")} from ${plural(wells, "well")}.`, "success");
  document.getElementById("entry-body").closest(".table-wrapper").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Wiring ---------------------------------------------------------------------------

function renderPlateMode() {
  document.getElementById("plate-od-field").hidden = !odMode;
  renderParseStatus();
  renderPlate();
}

document.addEventListener("DOMContentLoaded", () => {
  for (const id of ["plate-f", "plate-od"]) {
    document.getElementById(id).addEventListener("input", () => {
      renderParseStatus();
      renderPlate();
    });
  }
  for (const id of ["plate-role", "plate-conc", "plate-name", "plate-dilution"]) {
    document.getElementById(id).addEventListener("input", renderMarkControls);
  }
  document.getElementById("plate-mark-button").addEventListener("click", markSelection);
  document.getElementById("plate-clear-selection").addEventListener("click", () => {
    plateSelection.clear();
    plateAnchor = null;
    renderPlate();
  });
  document.getElementById("plate-fill-button").addEventListener("click", fillTableFromPlate);
  // Registered after js/plate_assay.js's own listener, so odMode is already switched.
  for (const radio of document.querySelectorAll('input[name="signal-mode"]')) {
    radio.addEventListener("change", renderPlateMode);
  }
  renderPlateMode();
});
