// =========================================================
// plate-assay.html: the Plate Reader Assay. Standards and samples read together (one plate, or
// any set of readings from any instrument) are typed or pasted into one table; a 4PL standard
// curve is fitted from the standards, and each sample's AHL is inferred through it.
//
// A one-off calculator: nothing is stored, and the curve is never reused on another set of
// readings, since a plate reader's signal scale changes with the instrument, gain and day. The
// CSV is the record. The math is js/curve_fit.js's CurveFit, the same code CAPTURE-Screen's
// calibration uses, so the same readings give the same curve on either page.
//
// Steps, each derived from the table and the fit, never stored:
//   1 Enter data  2 Fit  3 Results  4 Export
//
// The signal is either the fluorescence as entered, or F/OD600: each well's fluorescence and OD
// both less the medium blank's mean (medium only, no cells), then divided. Dividing by OD takes
// out how many cells a well happens to hold, which the biosensor's output also depends on.
// =========================================================

const ASSAY_MIN_REPS = 1;
const ASSAY_MAX_REPS = 6;
const ASSAY_START_REPS = 3;
const ASSAY_START_ROLES = ["standard", "standard", "standard", "standard", "standard", "standard", "standard", "standard",
  "sample", "sample", "sample"];
const ASSAY_TEXT_LIMIT = 200;
// The entry table's columns in order, which is also the order a pasted block fills them in.
const ASSAY_FIXED_COLUMNS = ["role", "key", "dilution"];

let repCount = ASSAY_START_REPS;
let odMode = false;              // signal = F/OD600, each less the medium blank; false = F as entered
// { id, role: "standard" | "sample" | "medium", key, dilution, reps: [F text], ods: [OD text],
// wells: [well id] }, cells as typed. ods is kept while OD normalization is off, so switching back
// and forth loses nothing. wells holds "B3" for a replicate filled from the plate import
// (js/plate_layout.js) and "" otherwise; editing that replicate's value clears it, since the
// value is then no longer the plate's.
const rows = [];
let nextRowId = 1;
const exclusions = new Map();    // reading id "rowId:rep" -> reason; present once ticked, reason may be empty
let fit = null;                  // CurveFit.fit() result plus fitted_at, or null when not fitted (or discarded)
let fitHasRunOnce = false;
let exported = false;            // a CSV was exported since the data last changed
let fitChart = null;

// ---- Formatting: concentration 1 dp (µM above 1000 nM), signal 4 significant figures ----------

function formatConcentration(nM) {
  if (nM === null || nM === undefined || !Number.isFinite(nM)) return "--";
  return nM > 1000 ? `${(nM / 1000).toFixed(1)} µM` : `${nM.toFixed(1)} nM`;
}

function formatInterval(interval) {
  if (!interval) return "--";
  return `${formatConcentration(interval[0])} – ${formatConcentration(interval[1])}`;
}

function formatSignal(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  if (value === 0) return "0";
  if (Math.abs(value) >= 1000) return String(Math.round(value));
  return String(Number(value.toPrecision(4)));
}

function formatSignedSignal(value) {
  if (!Number.isFinite(value)) return "--";
  const text = formatSignal(value);
  return value > 0 && text !== "0" ? `+${text}` : text;
}

function formatPercent(fraction) {
  if (!Number.isFinite(fraction)) return "--";
  return `${(fraction * 100).toFixed(1)}%`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

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

// A disabled button always says why next to it.
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

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---- The table's contents ------------------------------------------------------

// Number("") is 0, so an empty cell has to be caught before converting. Excel copies a cell as it
// is displayed, so "12,345" (comma thousands separators, only in groups of three) is accepted too;
// any other comma is not a number, since a decimal comma can't be told apart from it.
function parseNumber(text) {
  let trimmed = String(text).trim();
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) trimmed = trimmed.replace(/,/g, "");
  return trimmed === "" ? NaN : Number(trimmed);
}

function newRow(role) {
  return {
    id: nextRowId++, role, key: "", dilution: "1",
    reps: Array(repCount).fill(""), ods: Array(repCount).fill(""), wells: Array(repCount).fill(""),
  };
}

function isBlankText(text) {
  return text.trim() === "";
}

// A row with nothing typed in it is left out of everything, so the starting rows cost nothing.
function isEmptyRow(row) {
  return isBlankText(row.key) && row.reps.every(isBlankText) && row.ods.every(isBlankText);
}

// The value cells that count in the current mode: F only, or F and OD.
function rowValueTexts(row) {
  return odMode ? [...row.reps, ...row.ods] : row.reps;
}

// The medium blank: mean F and mean OD over every medium replicate with both, or null without one.
// Only used with OD normalization.
function mediumBlank() {
  if (!odMode) return null;
  const fs = [];
  const ods = [];
  for (const row of rows) {
    if (row.role !== "medium") continue;
    row.reps.forEach((text, rep) => {
      const f = parseNumber(text);
      const od = parseNumber(row.ods[rep]);
      if (Number.isFinite(f) && Number.isFinite(od)) {
        fs.push(f);
        ods.push(od);
      }
    });
  }
  return fs.length ? { f: CurveFit.mean(fs), od: CurveFit.mean(ods), n: fs.length } : null;
}

function readingId(row, rep) {
  return `${row.id}:${rep}`;
}

// Every usable replicate of a row, as { id, rep, y, f, od }: y is the signal the fit and the
// results use. With OD normalization a replicate needs both values and a medium blank, and its OD
// less the blank's must be positive; dataProblems() reports every replicate that falls short.
function rowReadings(row, blank = mediumBlank()) {
  const readings = [];
  row.reps.forEach((text, rep) => {
    const f = parseNumber(text);
    if (!Number.isFinite(f)) return;
    if (!odMode) {
      readings.push({ id: readingId(row, rep), rep, y: f, f, od: null });
      return;
    }
    const od = parseNumber(row.ods[rep]);
    if (!Number.isFinite(od) || !blank || !(od - blank.od > 0)) return;
    readings.push({ id: readingId(row, rep), rep, y: (f - blank.f) / (od - blank.od), f, od });
  });
  return readings;
}

// The standards, grouped by concentration (rows with the same concentration merge), ascending.
function standardGroups() {
  const groups = new Map();
  const blank = mediumBlank();
  for (const row of rows) {
    if (row.role !== "standard" || isEmptyRow(row)) continue;
    const c = parseNumber(row.key);
    if (!(Number.isFinite(c) && c >= 0)) continue;
    if (!groups.has(c)) groups.set(c, []);
    for (const reading of rowReadings(row, blank)) groups.get(c).push({ ...reading, row });
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([c, readings]) => ({ c, readings }));
}

function sampleRows() {
  return rows.filter((row) => row.role === "sample" && !isEmptyRow(row));
}

function experimentInfo() {
  const value = (id) => document.getElementById(id).value.trim();
  return {
    date: value("info-date"),
    strain: value("info-strain"),
    signal: value("info-signal"),
    instrument: value("info-instrument"),
    notes: value("info-notes"),
  };
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Row numbers as "Row 3" or "Rows 2, 5–8".
function rowList(numbers) {
  const parts = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    parts.push(j > i ? `${numbers[i]}–${numbers[j]}` : String(numbers[i]));
    i = j;
  }
  return `${numbers.length === 1 ? "Row" : "Rows"} ${parts.join(", ")}`;
}

// Everything that stops step 1 from being complete, all at once and grouped by kind, so one fix
// doesn't just reveal the next. Empty rows are skipped.
function dataProblems() {
  const problems = [];
  const info = experimentInfo();
  if (!info.date) problems.push("Enter the date.");
  else if (info.date > today()) problems.push("The date is in the future.");
  if (!info.strain) problems.push("Enter the biosensor strain.");
  if (!info.signal) problems.push("Enter the detection settings.");
  for (const [field, name] of [["strain", "biosensor strain"], ["signal", "detection text"], ["instrument", "instrument"], ["notes", "notes"]]) {
    if (info[field].length > ASSAY_TEXT_LIMIT) problems.push(`The ${name} is too long.`);
  }

  const byProblem = new Map();
  const add = (problem, n) => {
    if (!byProblem.has(problem)) byProblem.set(problem, []);
    if (!byProblem.get(problem).includes(n)) byProblem.get(problem).push(n);
  };
  const names = new Map();
  rows.forEach((row, i) => {
    if (isEmptyRow(row)) return;
    const n = i + 1;
    const key = row.key.trim();
    if (row.role === "medium") {
      if (!odMode) add("a medium blank is used only with Fluorescence ÷ OD600; select it or remove the row.", n);
    } else if (row.role === "standard") {
      if (!key) add("enter the concentration.", n);
      else if (!(parseNumber(key) >= 0)) add("concentration must be a number ≥ 0.", n);
    } else {
      if (!key) add("enter the sample name.", n);
      else if (key.length > ASSAY_TEXT_LIMIT) add("sample name is too long.", n);
      else {
        const folded = key.toLowerCase();
        if (names.has(folded)) {
          add("sample name used twice.", names.get(folded));
          add("sample name used twice.", n);
        } else {
          names.set(folded, n);
        }
      }
      if (!(parseNumber(row.dilution) >= 1)) add("dilution must be a number ≥ 1.", n);
    }
    const values = rowValueTexts(row).filter((text) => !isBlankText(text));
    if (values.length === 0) add("enter at least one replicate.", n);
    if (values.some((text) => !Number.isFinite(parseNumber(text)))) add("a value isn't a number.", n);
    // F and OD come from the same well: one without the other can't be divided.
    if (odMode && row.reps.some((text, rep) => isBlankText(text) !== isBlankText(row.ods[rep]))) {
      add("each replicate needs both F and OD.", n);
    }
  });
  for (const [problem, numbers] of byProblem) problems.push(`${rowList(numbers.sort((a, b) => a - b))}: ${problem}`);

  if (problems.length === 0 && odMode) {
    const blank = mediumBlank();
    if (!blank) {
      problems.push("Enter a medium blank (medium only, no cells): its F and OD are subtracted from every well.");
    } else {
      const low = [];
      rows.forEach((row, i) => {
        if (row.role === "medium" || isEmptyRow(row)) return;
        if (row.ods.some((text) => !isBlankText(text) && !(parseNumber(text) - blank.od > 0))) low.push(i + 1);
      });
      if (low.length) {
        problems.push(`${rowList(low)}: OD isn't above the medium blank's (${formatSignal(blank.od)}), so F/OD is undefined.`);
      }
    }
  }

  if (problems.length === 0) {
    const groups = standardGroups();
    const blanks = groups.find((g) => g.c === 0)?.readings.length ?? 0;
    const concentrations = groups.filter((g) => g.c > 0).length;
    if (concentrations < 4) problems.push("A 4PL fit needs at least 4 distinct non-zero concentrations.");
    if (blanks < 2) problems.push("Enter at least 2 blank readings (0 nM): LOD needs a blank SD.");
  }
  return problems;
}

// ---- Changes -------------------------------------------------------------------

// Any change to the standards discards the fit, so the curve can never describe other numbers.
// A sample's cells and the experiment info don't touch the fit; the results are recomputed from
// the table on every render, and both go into the export.
function dataChanged(affectsFit) {
  exported = false;
  if (affectsFit && fit) {
    fit = null;
    setStatus(document.getElementById("fit-status"), "Data changed, so the fit was discarded. Fit again.", "warn");
  }
  renderDerived();
}

// Exclusions only mean something for a reading that still exists and is still a standard.
function pruneExclusions() {
  const live = new Set(standardGroups().flatMap((g) => g.readings.map((r) => r.id)));
  for (const id of [...exclusions.keys()]) if (!live.has(id)) exclusions.delete(id);
}

function addRow(role) {
  rows.push(newRow(role));
  renderEntryTable();
  dataChanged(false);
  document.querySelector(`[data-cell="${rows.length - 1}:${role === "medium" ? "rep0" : "key"}"]`)?.focus();
}

function setRepCount(count) {
  repCount = Math.min(ASSAY_MAX_REPS, Math.max(ASSAY_MIN_REPS, count));
  for (const row of rows) {
    for (const field of ["reps", "ods", "wells"]) {
      row[field] = row[field].slice(0, repCount);
      while (row[field].length < repCount) row[field].push("");
    }
  }
  pruneExclusions();
  renderEntryTable();
  dataChanged(true);
}

// A block copied from Excel (tab-separated rows) fills the table from the cell it is pasted into,
// rightwards and downwards, adding rows as needed. The columns run role, concentration / name,
// dilution, the F replicates, then (with F/OD600) the OD replicates, so an F block and an OD block
// can be pasted one after the other. Without OD, replicate columns are added as needed; with it
// they aren't, since that would move every OD column.
function pasteBlock(startRow, startCol, text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const grid = lines.map((line) => line.split("\t"));
  const width = Math.max(...grid.map((cells) => cells.length));
  const lastCol = startCol + width - 1;
  if (!odMode) {
    const neededReps = lastCol - ASSAY_FIXED_COLUMNS.length + 1;
    if (neededReps > repCount) setRepCount(neededReps);
  }
  const valueColumns = repCount * (odMode ? 2 : 1);
  const ignoredColumns = Math.max(0, lastCol - (ASSAY_FIXED_COLUMNS.length + valueColumns - 1));

  const role = rows[startRow].role;
  grid.forEach((cells, r) => {
    const index = startRow + r;
    while (rows.length <= index) rows.push(newRow(role));
    const row = rows[index];
    cells.forEach((raw, c) => {
      const col = startCol + c;
      const text = raw.trim();
      const value = col - ASSAY_FIXED_COLUMNS.length;
      if (col === 0) {
        if (/^st/i.test(text)) row.role = "standard";
        else if (/^sa/i.test(text)) row.role = "sample";
        else if (/^m/i.test(text) && odMode) row.role = "medium";
      } else if (col === 1) {
        row.key = text;
      } else if (col === 2) {
        row.dilution = text;
      } else if (value < repCount) {
        row.reps[value] = text;
        row.wells[value] = "";
      } else if (odMode && value < 2 * repCount) {
        row.ods[value - repCount] = text;
        row.wells[value - repCount] = "";
      }
    });
  });

  pruneExclusions();
  renderEntryTable();
  dataChanged(true);
  const statusEl = document.getElementById("entry-status");
  const pasted = `Pasted ${plural(grid.length, "row")} × ${plural(width, "column")}.`;
  if (ignoredColumns > 0) {
    setStatus(statusEl, `${pasted} ${plural(ignoredColumns, "column")} past the last replicate ignored.`, "warn");
  } else {
    setStatus(statusEl, pasted, "success");
  }
}

// ---- 1. Enter data -------------------------------------------------------------

function cellInput(row, rowIndex, col, field, label) {
  const input = el("input", "table-input");
  input.type = "text";
  input.autocomplete = "off";
  if (field !== "key" || row.role === "standard") input.inputMode = "decimal";
  input.dataset.cell = `${rowIndex}:${field}`;
  input.setAttribute("aria-label", label);

  // "rep2" is the third F replicate, "od2" the OD of the same well.
  const valueCell = /^(rep|od)(\d+)$/.exec(field);
  const store = valueCell ? row[valueCell[1] === "rep" ? "reps" : "ods"] : null;
  const read = () => (valueCell ? store[Number(valueCell[2])] : row[field]);
  const write = (value) => {
    if (valueCell) {
      store[Number(valueCell[2])] = value;
      row.wells[Number(valueCell[2])] = "";
    } else {
      row[field] = value;
    }
  };
  input.value = read();

  const mark = () => {
    const text = read().trim();
    let invalid = false;
    if (text !== "") {
      const value = parseNumber(text);
      if (valueCell) invalid = !Number.isFinite(value);
      else if (field === "dilution") invalid = !(value >= 1);
      else if (row.role === "standard") invalid = !(value >= 0);
    }
    input.classList.toggle("is-missing", invalid);
    input.setAttribute("aria-invalid", String(invalid));
  };
  mark();

  input.addEventListener("input", () => {
    write(input.value);
    mark();
    // Only a standard's cells change the curve, and with F/OD600 a medium blank's too (it enters
    // every standard's signal); a sample's only change its own result.
    pruneExclusions();
    dataChanged(row.role === "standard" || (row.role === "medium" && odMode));
  });
  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!/[\t\n]/.test(text.replace(/\r?\n$/, ""))) return; // one value: let the browser paste it
    event.preventDefault();
    pasteBlock(rowIndex, col, text);
  });
  // Enter moves down the same column, adding a row at the bottom.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (rowIndex === rows.length - 1) {
      rows.push(newRow(row.role));
      renderEntryTable();
      dataChanged(false);
    }
    document.querySelector(`[data-cell="${rowIndex + 1}:${field}"]`)?.focus();
  });
  return input;
}

function renderEntryTable() {
  const head = document.getElementById("entry-head");
  const headRow = el("tr");
  for (const text of ["#", "Role", "Concentration (nM) / name", "Dilution"]) {
    headRow.appendChild(Object.assign(el("th", null, text), { scope: "col" }));
  }
  for (let rep = 0; rep < repCount; rep++) {
    headRow.appendChild(Object.assign(el("th", null, odMode ? `F ${rep + 1}` : `Rep ${rep + 1}`), { scope: "col" }));
  }
  if (odMode) {
    for (let rep = 0; rep < repCount; rep++) {
      headRow.appendChild(Object.assign(el("th", "od-head", `OD ${rep + 1}`), { scope: "col" }));
    }
  }
  const actions = Object.assign(el("th"), { scope: "col" });
  actions.appendChild(el("span", "visually-hidden", "Actions"));
  headRow.appendChild(actions);
  head.replaceChildren(headRow);

  const body = document.getElementById("entry-body");
  body.replaceChildren();
  rows.forEach((row, i) => {
    const n = i + 1;
    const tr = el("tr");
    const cell = (child, className) => {
      const td = el("td", className);
      td.appendChild(child);
      return td;
    };

    const role = el("select", "table-input");
    const roles = [["standard", "Standard"], ["sample", "Sample"]];
    // A medium row stays selectable after F/OD600 is switched off, so the problem list can point at it.
    if (odMode || row.role === "medium") roles.push(["medium", "Medium blank"]);
    for (const [value, text] of roles) {
      const option = el("option", null, text);
      option.value = value;
      role.appendChild(option);
    }
    role.value = row.role;
    role.setAttribute("aria-label", `Row ${n} role`);
    role.addEventListener("change", () => {
      row.role = role.value;
      row.key = "";
      row.dilution = "1";
      pruneExclusions();
      renderEntryTable();
      dataChanged(true);
      document.querySelector(`[data-cell="${i}:${row.role === "medium" ? "rep0" : "key"}"]`)?.focus();
    });

    const key = cellInput(row, i, 1, "key", row.role === "standard" ? `Row ${n} concentration (nM)` : `Row ${n} sample name`);
    key.placeholder = { standard: "nM", sample: "Name", medium: "" }[row.role];
    key.disabled = row.role === "medium";
    const dilution = cellInput(row, i, 2, "dilution", `Row ${n} dilution`);
    dilution.disabled = row.role !== "sample";
    if (dilution.disabled) dilution.value = "";

    const remove = el("button", "btn-secondary table-button", "Remove");
    remove.type = "button";
    remove.disabled = rows.length === 1;
    remove.setAttribute("aria-label", `Remove row ${n}`);
    remove.addEventListener("click", () => {
      rows.splice(i, 1);
      pruneExclusions();
      renderEntryTable();
      dataChanged(row.role === "standard" && !isEmptyRow(row));
    });

    tr.append(el("td", null, String(n)), cell(role), cell(key), cell(dilution, "dilution-cell"));
    for (let rep = 0; rep < repCount; rep++) {
      const label = odMode ? `Row ${n} replicate ${rep + 1} fluorescence` : `Row ${n} replicate ${rep + 1}`;
      tr.appendChild(cell(cellInput(row, i, ASSAY_FIXED_COLUMNS.length + rep, `rep${rep}`, label), "rep-cell"));
    }
    if (odMode) {
      for (let rep = 0; rep < repCount; rep++) {
        const col = ASSAY_FIXED_COLUMNS.length + repCount + rep;
        tr.appendChild(cell(cellInput(row, i, col, `od${rep}`, `Row ${n} replicate ${rep + 1} OD600`), "rep-cell od-cell"));
      }
    }
    tr.appendChild(cell(remove, "action-cell"));
    body.appendChild(tr);
  });

  document.getElementById("add-medium").hidden = !odMode;
  document.getElementById("od-note").hidden = !odMode;
  document.getElementById("add-rep").disabled = repCount >= ASSAY_MAX_REPS;
  document.getElementById("remove-rep").disabled = repCount <= ASSAY_MIN_REPS;
}

function renderEntrySummary() {
  const groups = standardGroups();
  const blanks = groups.find((g) => g.c === 0)?.readings.length ?? 0;
  const concentrations = groups.filter((g) => g.c > 0).length;
  const medium = odMode ? `, ${plural(mediumBlank()?.n ?? 0, "medium reading")}` : "";
  document.getElementById("entry-summary").textContent =
    `${plural(concentrations, "concentration")}, ${plural(blanks, "blank reading")}, ${plural(sampleRows().length, "sample")}${medium} · `
    + "a fit needs at least 4 concentrations and 2 blank readings";
}

// Switching the signal changes every value the fit used. The first switch to F/OD600 adds an empty
// medium blank row at the top, since without one nothing can be divided.
function setOdMode(on) {
  odMode = on;
  if (on && !rows.some((row) => row.role === "medium")) rows.unshift(newRow("medium"));
  pruneExclusions();
  renderEntryTable();
  dataChanged(true);
}

// ---- 2. Fit --------------------------------------------------------------------

// A reading by its well when it came from the plate import, else by its place in the table.
function readingLabel(row, rep) {
  return row.wells[rep] || `Row ${rows.indexOf(row) + 1} · Rep ${rep + 1}`;
}

function isExcluded(reading) {
  return exclusions.has(reading.id);
}

function missingReasonCount() {
  return [...exclusions.values()].filter((reason) => !reason.trim()).length;
}

function countedPoints() {
  return standardGroups().flatMap((g) => g.readings.filter((r) => !isExcluded(r)).map((r) => ({ c: g.c, y: r.y, sd: 0 })));
}

// Why Fit can't run, or null: CurveFit's own refusals, said before the button is pressed.
function blockedFitReason() {
  if (fit) return "Already fitted. Change the data or an exclusion to fit again.";
  const points = countedPoints();
  const blanks = points.filter((pt) => pt.c === 0).length;
  if (blanks < 2) return `The counted readings include ${plural(blanks, "blank")}; LOD needs at least 2.`;
  const concentrations = new Set(points.filter((pt) => pt.c > 0).map((pt) => pt.c)).size;
  if (concentrations < 4) return `The counted readings cover ${plural(concentrations, "concentration")}; a 4PL fit needs at least 4.`;
  const missing = missingReasonCount();
  if (missing > 0) return `Give a reason for every excluded reading (${missing} missing).`;
  return null;
}

function runFit() {
  const statusEl = document.getElementById("fit-status");
  try {
    fit = { ...CurveFit.fit(countedPoints()), fitted_at: new Date().toISOString() };
    fitHasRunOnce = true;
    exported = false;
    setStatus(statusEl, "Fitted.", "success"); // the numbers are in the tiles below
  } catch (err) {
    fit = null;
    setStatus(statusEl, `Fit failed: ${err.message}`, "error");
  }
  renderDerived();
}

function toggleExclusion(id, checked) {
  if (checked) exclusions.set(id, exclusions.get(id) ?? "");
  else exclusions.delete(id);
  if (fit) {
    fit = null;
    setStatus(document.getElementById("fit-status"), "Exclusions changed, so the previous fit was discarded. Fit again.", "warn");
  }
  exported = false;
  renderDerived();
  if (checked) document.querySelector(`[data-reason-for="${id}"]`)?.focus();
}

function renderFitTable() {
  const tbody = document.getElementById("fit-table-body");
  tbody.replaceChildren();
  for (const th of document.querySelectorAll("#fit-card .od-col")) th.hidden = !odMode;
  for (const group of standardGroups()) {
    const countedYs = group.readings.filter((r) => !isExcluded(r)).map((r) => r.y);
    const mean = countedYs.length ? CurveFit.mean(countedYs) : null;
    const meanResidual = fit && mean !== null ? mean - CurveFit.model(group.c, fit.params) : null;

    group.readings.forEach((reading, index) => {
      const excluded = isExcluded(reading);
      const label = readingLabel(reading.row, reading.rep);
      const tr = el("tr");
      tr.classList.toggle("is-excluded", excluded);
      if (index === 0) {
        tr.classList.add("group-start");
        const rowSpan = group.readings.length;
        const groupCell = (text) => Object.assign(el("td", "group-cell", text), { rowSpan });
        tr.append(
          groupCell(group.c === 0 ? "Blank (0 nM)" : formatConcentration(group.c)),
          groupCell(String(countedYs.length)),
          groupCell(mean === null ? "--" : formatSignal(mean)),
          groupCell(meanResidual === null ? "--" : formatSignedSignal(meanResidual)),
        );
      }

      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.checked = excluded;
      checkbox.setAttribute("aria-label", `Exclude ${label}`);
      checkbox.addEventListener("change", () => toggleExclusion(reading.id, checkbox.checked));
      const excludeCell = el("td");
      excludeCell.appendChild(checkbox);

      const reasonCell = el("td");
      if (excluded) {
        const reason = el("input", "table-input");
        reason.type = "text";
        reason.value = exclusions.get(reading.id);
        reason.placeholder = "Reason (required)";
        reason.dataset.reasonFor = reading.id;
        reason.setAttribute("aria-label", `Reason for excluding ${label}`);
        reason.classList.toggle("is-missing", !reason.value.trim());
        reason.addEventListener("input", () => {
          exclusions.set(reading.id, reason.value);
          reason.classList.toggle("is-missing", !reason.value.trim());
          exported = false;
          renderControls(); // not the table, so typing mid-word doesn't lose focus
        });
        reasonCell.appendChild(reason);
      }

      tr.append(el("td", null, label));
      if (odMode) tr.append(el("td", null, formatSignal(reading.f)), el("td", null, formatSignal(reading.od)));
      tr.append(
        el("td", null, formatSignal(reading.y)),
        el("td", null, fit ? formatSignedSignal(reading.y - CurveFit.model(group.c, fit.params)) : "--"),
        excludeCell,
        reasonCell,
      );
      tbody.appendChild(tr);
    });
  }
}

// Error bars. Chart.js has none built in, so they are drawn here: a dataset with errorBars: true
// gets a bar of each point's sd above and below it.
const errorBarPlugin = {
  id: "assayErrorBars",
  afterDatasetsDraw(chart) {
    const { ctx, scales } = chart;
    chart.data.datasets.forEach((dataset, i) => {
      if (!dataset.errorBars || !chart.isDatasetVisible(i)) return;
      ctx.save();
      ctx.strokeStyle = dataset.borderColor;
      ctx.lineWidth = 1.5;
      for (const point of dataset.data) {
        if (!(point.sd > 0)) continue;
        const x = scales.x.getPixelForValue(point.x);
        const top = scales.y.getPixelForValue(point.y + point.sd);
        const bottom = scales.y.getPixelForValue(point.y - point.sd);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.moveTo(x - 5, top);
        ctx.lineTo(x + 5, top);
        ctx.moveTo(x - 5, bottom);
        ctx.lineTo(x + 5, bottom);
        ctx.stroke();
      }
      ctx.restore();
    });
  },
};

function renderFitChart() {
  if (fitChart) fitChart.destroy();
  fitChart = null;
  const fluor = cssVar("--fluor");
  const gold = cssVar("--gold");
  const ink = cssVar("--text");
  const muted = cssVar("--muted");
  const rule = cssVar("--border");

  const groups = standardGroups().filter((g) => g.c > 0);
  const points = (keep) => groups.flatMap((g) => g.readings.filter(keep).map((r) => ({ x: g.c, y: r.y })));
  const included = points((r) => !isExcluded(r));
  const excluded = points(isExcluded);
  const means = groups
    .map((g) => ({ c: g.c, ys: g.readings.filter((r) => !isExcluded(r)).map((r) => r.y) }))
    .filter(({ ys }) => ys.length > 0)
    .map(({ c, ys }) => ({ x: c, y: CurveFit.mean(ys), sd: CurveFit.sampleSd(ys) }));

  const datasets = [
    { label: "Reading (counted)", data: included, pointRadius: 3, pointBackgroundColor: fluor, pointBorderColor: fluor, showLine: false },
    {
      label: "Reading (excluded)", data: excluded, pointRadius: 4.5, pointBackgroundColor: "rgba(0,0,0,0)",
      pointBorderColor: muted, pointBorderWidth: 1.5, showLine: false,
    },
    {
      label: "Mean ± SD", data: means, pointStyle: "rect", pointRadius: 5, pointBackgroundColor: ink,
      pointBorderColor: ink, borderColor: ink, showLine: false, errorBars: true,
    },
  ];

  if (fit && groups.length > 0) {
    // Drawn only across the standards' range: beyond it would be extrapolating on the chart.
    const lo = Math.log10(groups[0].c);
    const hi = Math.log10(groups[groups.length - 1].c);
    const steps = 160;
    const curvePoints = Array.from({ length: steps + 1 }, (_, i) => {
      const x = 10 ** (lo + ((hi - lo) * i) / steps);
      return { x, y: CurveFit.model(x, fit.params) };
    });
    const allY = [...included, ...excluded, ...curvePoints].map((p) => p.y)
      .concat(means.flatMap((p) => [p.y - p.sd, p.y + p.sd]));
    datasets.push(
      { label: "4PL fit", data: curvePoints, type: "line", pointRadius: 0, borderWidth: 2, tension: 0, borderColor: gold },
      {
        label: "EC50",
        data: [{ x: fit.params.ec50_nM, y: Math.min(...allY) }, { x: fit.params.ec50_nM, y: Math.max(...allY) }],
        type: "line", pointRadius: 0, borderWidth: 1.5, borderDash: [6, 4], borderColor: muted,
      },
    );
  }

  fitChart = new Chart(document.getElementById("fit-chart"), {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      aspectRatio: 2.2,
      animation: false,
      scales: {
        x: {
          type: "logarithmic",
          title: { display: true, text: "AHL (nM, log scale)", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
        y: {
          title: { display: true, text: signalLabel(), color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
      },
      plugins: { legend: { labels: { color: ink } } },
    },
    plugins: [errorBarPlugin],
  });
}

// What the signal axis and the CSV call the number that was fitted.
function signalLabel() {
  const signal = experimentInfo().signal || "Signal";
  return odMode ? `${signal} ÷ OD600, less medium blank (a.u.)` : signal;
}

function renderFitMetrics() {
  const set = (id, text) => { document.getElementById(id).textContent = text; };
  if (!fit) {
    ["fit-ec50", "fit-hill", "fit-lod", "fit-rmse"].forEach((id) => set(id, "--"));
    ["fit-ec50-sub", "fit-hill-sub", "fit-lod-sub", "fit-rmse-sub"].forEach((id) => set(id, "Not fitted"));
    return;
  }
  set("fit-ec50", formatConcentration(fit.params.ec50_nM));
  set("fit-ec50-sub", `Usable range ${formatInterval([fit.range_nM.min, fit.range_nM.max])}`);
  set("fit-hill", fit.params.hill.toFixed(2));
  set("fit-hill-sub", `Top ${formatSignal(fit.params.top)} · bottom ${formatSignal(fit.params.bottom)}`);
  set("fit-lod", formatConcentration(fit.lod_nM));
  set("fit-lod-sub", `LOQ ${formatConcentration(fit.loq_nM)}`);
  set("fit-rmse", formatSignal(fit.rmse));
  set("fit-rmse-sub", "Signal units");
}

// ---- 3. Results ----------------------------------------------------------------

// One sample: its replicates' mean converted once (reading variance divided by n), then scaled by
// its dilution. A number only inside the usable range, never an extrapolation.
function sampleResult(row) {
  const ys = rowReadings(row).map((r) => r.y);
  const dilution = parseNumber(row.dilution);
  const mean = CurveFit.mean(ys);
  const sd = ys.length >= 2 ? CurveFit.sampleSd(ys) : null;
  const estimate = CurveFit.invert(mean, fit, ys.length);
  const ok = estimate.status === "ok";
  return {
    row,
    ys,
    n: ys.length,
    mean,
    sd,
    cv: sd !== null && mean !== 0 ? sd / Math.abs(mean) : null,
    dilution,
    status: estimate.status,
    well_nM: ok ? estimate.concentration_nM : null,
    well_ci: ok ? estimate.ci95_nM : null,
    sample_nM: ok ? estimate.concentration_nM * dilution : null,
    sample_ci: ok ? estimate.ci95_nM.map((v) => v * dilution) : null,
  };
}

// Outside the range only the bound is shown, scaled like the number would have been.
function formatResult(result, value, scale) {
  if (result.status === "below_lod") return `< ${formatConcentration(fit.range_nM.min * scale)}`;
  if (result.status === "above_range") return `> ${formatConcentration(fit.range_nM.max * scale)}`;
  return formatConcentration(value);
}

function renderResults() {
  if (!fit) return;
  document.getElementById("results-range").textContent =
    `Values are given only within the usable range (${formatInterval([fit.range_nM.min, fit.range_nM.max])} in the well); outside it, only the bound is shown.`;
  const samples = sampleRows();
  document.getElementById("results-empty").hidden = samples.length > 0;
  document.getElementById("results-table-wrapper").hidden = samples.length === 0;
  const tbody = document.getElementById("results-body");
  tbody.replaceChildren();
  for (const row of samples) {
    const result = sampleResult(row);
    const tr = el("tr");
    tr.append(
      el("td", null, row.key.trim()),
      el("td", null, String(result.n)),
      el("td", null, formatSignal(result.mean)),
      el("td", null, result.sd === null ? "--" : formatSignal(result.sd)),
      el("td", null, result.cv === null ? "--" : formatPercent(result.cv)),
      el("td", null, formatResult(result, result.well_nM, 1)),
      el("td", null, result.well_ci ? formatInterval(result.well_ci) : "--"),
      el("td", null, `×${result.dilution}`),
      el("td", null, formatResult(result, result.sample_nM, result.dilution)),
      el("td", null, result.sample_ci ? formatInterval(result.sample_ci) : "--"),
    );
    tbody.appendChild(tr);
  }
}

// ---- 4. Export -----------------------------------------------------------------

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

function fileStem() {
  const info = experimentInfo();
  const strain = info.strain.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return `plate-assay-${info.date}${strain ? `-${strain}` : ""}`;
}

const CSV_HEADERS = [
  "date", "strain", "signal_description", "instrument", "notes",
  "normalization", "medium_f_mean", "medium_od_mean",
  "row", "role", "concentration_nM", "sample", "dilution", "replicate", "well", "fluorescence", "od600", "signal", "excluded_reason",
  "model", "fitted_at", "top", "bottom", "ec50_nM", "hill", "lod_nM", "loq_nM", "range_min_nM", "range_max_nM", "rmse",
  "sample_n", "sample_mean", "sample_sd", "status", "ahl_well_nM", "ci95_well_low_nM", "ci95_well_high_nM",
  "ahl_sample_nM", "ci95_sample_low_nM", "ci95_sample_high_nM",
];

// A row per replicate, excluded ones included with their reason and medium blanks included too; the
// normalization, the curve and, for a sample, its result sit beside each row, so any row reads on
// its own. signal is the number that was fitted or converted (F, or F/OD600 less the medium blank).
// Full precision, never the display format.
function csvRows() {
  const info = experimentInfo();
  const blank = mediumBlank();
  const normalization = odMode ? ["F/OD600", blank.f, blank.od] : ["none", null, null];
  const curve = [
    "4PL", fit.fitted_at, fit.params.top, fit.params.bottom, fit.params.ec50_nM, fit.params.hill,
    fit.lod_nM, fit.loq_nM, fit.range_nM.min, fit.range_nM.max, fit.rmse,
  ];
  const out = [];
  rows.forEach((row, i) => {
    if (isEmptyRow(row)) return;
    const standard = row.role === "standard";
    const sample = row.role === "sample";
    const result = sample ? sampleResult(row) : null;
    const signals = new Map(rowReadings(row, blank).map((r) => [r.rep, r.y]));
    row.reps.forEach((text, rep) => {
      const f = parseNumber(text);
      if (!Number.isFinite(f)) return;
      out.push([
        info.date, info.strain, info.signal, info.instrument, info.notes,
        ...normalization,
        i + 1, row.role, standard ? parseNumber(row.key) : null, sample ? row.key.trim() : null,
        sample ? result.dilution : null, rep + 1, row.wells[rep] || null, f, odMode ? parseNumber(row.ods[rep]) : null,
        row.role === "medium" ? null : signals.get(rep) ?? null,
        standard ? exclusions.get(readingId(row, rep)) ?? null : null,
        ...curve,
        ...(result
          ? [result.n, result.mean, result.sd, result.status, result.well_nM, result.well_ci?.[0], result.well_ci?.[1],
            result.sample_nM, result.sample_ci?.[0], result.sample_ci?.[1]]
          : Array(10).fill(null)),
      ]);
    });
  });
  return out;
}

// CRLF and a UTF-8 BOM, both for Excel: without the BOM it decodes the file as the system codepage.
function exportCsv() {
  const text = [CSV_HEADERS, ...csvRows()].map((r) => r.map(csvCell).join(",")).join("\r\n");
  downloadBlob(`${fileStem()}.csv`, new Blob([`﻿${text}\r\n`], { type: "text/csv;charset=utf-8" }));
  exported = true;
  setStatus(document.getElementById("export-status"), `Exported ${fileStem()}.csv.`, "success");
  renderDerived();
}

// The chart on a white background, since the canvas itself is transparent.
function exportPng() {
  const source = document.getElementById("fit-chart");
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  canvas.toBlob((blob) => {
    downloadBlob(`${fileStem()}-curve.png`, blob);
    setStatus(document.getElementById("export-status"), `Exported ${fileStem()}-curve.png.`, "success");
  }, "image/png");
}

// ---- Rendering -----------------------------------------------------------------

function renderControls() {
  const problems = dataProblems();
  const dataReason = document.getElementById("data-reason");
  dataReason.textContent = problems.join(" ");
  dataReason.hidden = problems.length === 0;

  // Stays in place once fitted, disabled with the reason ("Already fitted…").
  setBlocked(document.getElementById("fit-button"), document.getElementById("fit-reason"), blockedFitReason());

  // Step 1 incomplete (even with a fit, e.g. the strain cleared afterwards) holds every later step,
  // so nothing is shown or exported without the experiment it belongs to.
  const ready = problems.length === 0;
  const waitFor = !ready ? "Complete step 1 first."
    : fitHasRunOnce ? "Fit the curve again: the data or exclusions changed." : "Fit the curve first.";
  setStepCard(document.getElementById("data-card"), ready ? "done" : "current");
  setStepCard(document.getElementById("fit-card"), !ready ? "waiting" : fit ? "done" : "current", waitFor);
  setStepCard(document.getElementById("results-card"), ready && fit ? "done" : "waiting", waitFor);
  setStepCard(document.getElementById("export-card"), ready && fit ? (exported ? "done" : "current") : "waiting", waitFor);
  return problems;
}

// Everything but the entry table, which is rebuilt only when its shape changes so typing keeps focus.
function renderDerived() {
  renderEntrySummary();
  const problems = renderControls();
  if (problems.length === 0) {
    renderFitTable();
    renderFitChart();
    renderFitMetrics();
  }
  renderResults();
}

function hasData() {
  return rows.some((row) => !isEmptyRow(row));
}

document.addEventListener("DOMContentLoaded", () => {
  for (const role of ASSAY_START_ROLES) rows.push(newRow(role));
  document.getElementById("info-date").value = today();
  document.getElementById("info-date").max = today();

  for (const id of ["info-date", "info-strain", "info-signal", "info-instrument", "info-notes"]) {
    document.getElementById(id).addEventListener("input", () => dataChanged(false));
  }
  document.getElementById("add-standard").addEventListener("click", () => addRow("standard"));
  document.getElementById("add-sample").addEventListener("click", () => addRow("sample"));
  document.getElementById("add-medium").addEventListener("click", () => addRow("medium"));
  for (const radio of document.querySelectorAll('input[name="signal-mode"]')) {
    radio.addEventListener("change", () => setOdMode(radio.value === "od" && radio.checked));
  }
  document.getElementById("add-rep").addEventListener("click", () => setRepCount(repCount + 1));
  document.getElementById("remove-rep").addEventListener("click", () => setRepCount(repCount - 1));
  document.getElementById("fit-button").addEventListener("click", runFit);
  document.getElementById("export-csv").addEventListener("click", exportCsv);
  document.getElementById("export-png").addEventListener("click", exportPng);

  // Nothing is stored, so leaving with unexported data asks first.
  window.addEventListener("beforeunload", (event) => {
    if (!hasData() || exported) return;
    event.preventDefault();
    event.returnValue = "";
  });

  renderEntryTable();
  renderDerived();
});
