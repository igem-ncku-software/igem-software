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
const rows = [];                 // { id, role: "standard" | "sample", key, dilution, reps: [text] }, cells as typed
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

// Number("") is 0, so an empty cell has to be caught before converting.
function parseNumber(text) {
  const trimmed = String(text).trim();
  return trimmed === "" ? NaN : Number(trimmed);
}

function newRow(role) {
  return { id: nextRowId++, role, key: "", dilution: "1", reps: Array(repCount).fill("") };
}

// A row with nothing typed in it is left out of everything, so the starting rows cost nothing.
function isEmptyRow(row) {
  return row.key.trim() === "" && row.reps.every((text) => text.trim() === "");
}

function readingId(row, rep) {
  return `${row.id}:${rep}`;
}

// Every filled, numeric replicate cell of a row, as { id, rep, y }.
function rowReadings(row) {
  const readings = [];
  row.reps.forEach((text, rep) => {
    const y = parseNumber(text);
    if (Number.isFinite(y)) readings.push({ id: readingId(row, rep), rep, y });
  });
  return readings;
}

// The standards, grouped by concentration (rows with the same concentration merge), ascending.
function standardGroups() {
  const groups = new Map();
  for (const row of rows) {
    if (row.role !== "standard" || isEmptyRow(row)) continue;
    const c = parseNumber(row.key);
    if (!(Number.isFinite(c) && c >= 0)) continue;
    if (!groups.has(c)) groups.set(c, []);
    for (const reading of rowReadings(row)) groups.get(c).push({ ...reading, row });
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
  if (!info.signal) problems.push("Enter the signal.");
  for (const [field, name] of [["strain", "biosensor strain"], ["signal", "signal"], ["instrument", "instrument"], ["notes", "notes"]]) {
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
    if (row.role === "standard") {
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
    const filled = row.reps.filter((text) => text.trim() !== "");
    if (filled.length === 0) add("enter at least one replicate.", n);
    if (filled.some((text) => !Number.isFinite(parseNumber(text)))) add("a replicate is not a number.", n);
  });
  for (const [problem, numbers] of byProblem) problems.push(`${rowList(numbers.sort((a, b) => a - b))}: ${problem}`);

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

// Any change to the readings discards the fit, so the results can never describe other numbers.
// Experiment info doesn't touch the fit, but it does go into the export.
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
  document.querySelector(`[data-cell="${rows.length - 1}:key"]`)?.focus();
}

function setRepCount(count) {
  repCount = Math.min(ASSAY_MAX_REPS, Math.max(ASSAY_MIN_REPS, count));
  for (const row of rows) {
    row.reps = row.reps.slice(0, repCount);
    while (row.reps.length < repCount) row.reps.push("");
  }
  pruneExclusions();
  renderEntryTable();
  dataChanged(true);
}

// A block copied from Excel (tab-separated rows) fills the table from the cell it is pasted into,
// rightwards and downwards, adding rows and replicate columns as needed.
function pasteBlock(startRow, startCol, text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const grid = lines.map((line) => line.split("\t"));
  const width = Math.max(...grid.map((cells) => cells.length));
  const lastCol = startCol + width - 1;
  const neededReps = lastCol - ASSAY_FIXED_COLUMNS.length + 1;
  let ignoredColumns = 0;
  if (neededReps > repCount) {
    ignoredColumns = Math.max(0, neededReps - ASSAY_MAX_REPS);
    setRepCount(neededReps);
  }

  const role = rows[startRow].role;
  grid.forEach((cells, r) => {
    const index = startRow + r;
    while (rows.length <= index) rows.push(newRow(role));
    const row = rows[index];
    cells.forEach((raw, c) => {
      const col = startCol + c;
      const text = raw.trim();
      if (col === 0) {
        if (/^st/i.test(text)) row.role = "standard";
        else if (/^sa/i.test(text)) row.role = "sample";
      } else if (col === 1) {
        row.key = text;
      } else if (col === 2) {
        row.dilution = text;
      } else if (col - ASSAY_FIXED_COLUMNS.length < repCount) {
        row.reps[col - ASSAY_FIXED_COLUMNS.length] = text;
      }
    });
  });

  pruneExclusions();
  renderEntryTable();
  dataChanged(true);
  const statusEl = document.getElementById("entry-status");
  const pasted = `Pasted ${plural(grid.length, "row")} × ${plural(width, "column")}.`;
  if (ignoredColumns > 0) {
    setStatus(statusEl, `${pasted} ${plural(ignoredColumns, "column")} past Rep ${ASSAY_MAX_REPS} ignored.`, "warn");
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

  const read = () => (field.startsWith("rep") ? row.reps[Number(field.slice(3))] : row[field]);
  const write = (value) => {
    if (field.startsWith("rep")) row.reps[Number(field.slice(3))] = value;
    else row[field] = value;
  };
  input.value = read();

  const mark = () => {
    const text = read().trim();
    let invalid = false;
    if (text !== "") {
      const value = parseNumber(text);
      if (field.startsWith("rep")) invalid = !Number.isFinite(value);
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
    // A sample's name or dilution doesn't change the curve; a standard's cells and every value do.
    pruneExclusions();
    dataChanged(field.startsWith("rep") || row.role === "standard");
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
  for (let rep = 0; rep < repCount; rep++) headRow.appendChild(Object.assign(el("th", null, `Rep ${rep + 1}`), { scope: "col" }));
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
    for (const [value, text] of [["standard", "Standard"], ["sample", "Sample"]]) {
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
      document.querySelector(`[data-cell="${i}:key"]`)?.focus();
    });

    const key = cellInput(row, i, 1, "key", row.role === "standard" ? `Row ${n} concentration (nM)` : `Row ${n} sample name`);
    key.placeholder = row.role === "standard" ? "nM" : "Name";
    const dilution = cellInput(row, i, 2, "dilution", `Row ${n} dilution`);
    dilution.disabled = row.role === "standard";
    if (dilution.disabled) dilution.value = "";

    const remove = el("button", "btn-secondary table-button", "Remove");
    remove.type = "button";
    remove.disabled = rows.length === 1;
    remove.setAttribute("aria-label", `Remove row ${n}`);
    remove.addEventListener("click", () => {
      rows.splice(i, 1);
      pruneExclusions();
      renderEntryTable();
      dataChanged(true);
    });

    tr.append(el("td", null, String(n)), cell(role), cell(key), cell(dilution, "dilution-cell"));
    for (let rep = 0; rep < repCount; rep++) {
      tr.appendChild(cell(cellInput(row, i, ASSAY_FIXED_COLUMNS.length + rep, `rep${rep}`, `Row ${n} replicate ${rep + 1}`), "rep-cell"));
    }
    tr.appendChild(cell(remove, "action-cell"));
    body.appendChild(tr);
  });

  document.getElementById("add-rep").disabled = repCount >= ASSAY_MAX_REPS;
  document.getElementById("remove-rep").disabled = repCount <= ASSAY_MIN_REPS;
}

function renderEntrySummary() {
  const groups = standardGroups();
  const blanks = groups.find((g) => g.c === 0)?.readings.length ?? 0;
  const concentrations = groups.filter((g) => g.c > 0).length;
  document.getElementById("entry-summary").textContent =
    `${plural(concentrations, "concentration")}, ${plural(blanks, "blank reading")}, ${plural(sampleRows().length, "sample")} · `
    + "a fit needs at least 4 concentrations and 2 blank readings";
}

function goToFit() {
  document.getElementById("fit-card").scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("fit-button").focus({ preventScroll: true });
}

// ---- 2. Fit --------------------------------------------------------------------

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
  if (fit) document.getElementById("fit-next-button").focus();
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
  for (const group of standardGroups()) {
    const countedYs = group.readings.filter((r) => !isExcluded(r)).map((r) => r.y);
    const mean = countedYs.length ? CurveFit.mean(countedYs) : null;
    const meanResidual = fit && mean !== null ? mean - CurveFit.model(group.c, fit.params) : null;

    group.readings.forEach((reading, index) => {
      const excluded = isExcluded(reading);
      const label = `Row ${rows.indexOf(reading.row) + 1} · Rep ${reading.rep + 1}`;
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

      tr.append(
        el("td", null, label),
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
  const accent = cssVar("--accent");
  const gold = cssVar("--gold");
  const error = cssVar("--error");
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
    { label: "Reading (counted)", data: included, pointRadius: 3, pointBackgroundColor: accent, pointBorderColor: accent, showLine: false },
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
        type: "line", pointRadius: 0, borderWidth: 1.5, borderDash: [6, 4], borderColor: error,
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
          title: { display: true, text: experimentInfo().signal || "Signal", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
      },
      plugins: { legend: { labels: { color: ink } } },
    },
    plugins: [errorBarPlugin],
  });
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
function formatResult(result, scale) {
  if (result.status === "below_lod") return `< ${formatConcentration(fit.range_nM.min * scale)}`;
  if (result.status === "above_range") return `> ${formatConcentration(fit.range_nM.max * scale)}`;
  return formatConcentration((scale === 1 ? result.well_nM : result.sample_nM));
}

function renderResults() {
  if (!fit) return;
  document.getElementById("results-range").textContent =
    `Numbers only inside the usable range, ${formatInterval([fit.range_nM.min, fit.range_nM.max])} in the well.`;
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
      el("td", null, formatResult(result, 1)),
      el("td", null, result.well_ci ? formatInterval(result.well_ci) : "--"),
      el("td", null, `×${result.dilution}`),
      el("td", null, formatResult(result, result.dilution)),
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
  "date", "strain", "signal", "instrument", "notes",
  "row", "role", "concentration_nM", "sample", "dilution", "replicate", "value", "excluded_reason",
  "model", "fitted_at", "top", "bottom", "ec50_nM", "hill", "lod_nM", "loq_nM", "range_min_nM", "range_max_nM", "rmse",
  "sample_n", "sample_mean", "sample_sd", "status", "ahl_well_nM", "ci95_well_low_nM", "ci95_well_high_nM",
  "ahl_sample_nM", "ci95_sample_low_nM", "ci95_sample_high_nM",
];

// A row per reading, excluded ones included with their reason; the curve and, for a sample, its
// result sit beside each reading, so any row reads on its own. Full precision, never the display format.
function csvRows() {
  const info = experimentInfo();
  const curve = [
    "4PL", fit.fitted_at, fit.params.top, fit.params.bottom, fit.params.ec50_nM, fit.params.hill,
    fit.lod_nM, fit.loq_nM, fit.range_nM.min, fit.range_nM.max, fit.rmse,
  ];
  const out = [];
  rows.forEach((row, i) => {
    if (isEmptyRow(row)) return;
    const standard = row.role === "standard";
    const result = standard ? null : sampleResult(row);
    for (const reading of rowReadings(row)) {
      out.push([
        info.date, info.strain, info.signal, info.instrument, info.notes,
        i + 1, row.role, standard ? parseNumber(row.key) : null, standard ? null : row.key.trim(),
        standard ? null : result.dilution, reading.rep + 1, reading.y, standard ? exclusions.get(reading.id) ?? null : null,
        ...curve,
        ...(result
          ? [result.n, result.mean, result.sd, result.status, result.well_nM, result.well_ci?.[0], result.well_ci?.[1],
            result.sample_nM, result.sample_ci?.[0], result.sample_ci?.[1]]
          : Array(10).fill(null)),
      ]);
    }
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
  const dataReason = problems.join(" ");
  setBlocked(document.getElementById("data-next"), document.getElementById("data-reason"), dataReason);

  const fitButton = document.getElementById("fit-button");
  fitButton.hidden = Boolean(fit);
  document.getElementById("fit-next-button").hidden = !fit;
  setBlocked(fitButton, document.getElementById("fit-reason"), fit ? null : blockedFitReason());

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
  document.getElementById("add-rep").addEventListener("click", () => setRepCount(repCount + 1));
  document.getElementById("remove-rep").addEventListener("click", () => setRepCount(repCount - 1));
  document.getElementById("data-next").addEventListener("click", goToFit);
  document.getElementById("fit-button").addEventListener("click", runFit);
  document.getElementById("fit-next-button").addEventListener("click", () => {
    document.getElementById("results-card").scrollIntoView({ behavior: "smooth", block: "start" });
  });
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
