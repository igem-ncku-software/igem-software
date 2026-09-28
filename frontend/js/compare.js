// =========================================================
// compare.html: cross-validation. The same samples inferred on a plate reader (a Plate Reader
// Assay CSV) and on CAPTURE-Screen (a Measure batch, from this browser or its CSV) are paired by
// name, and the two inferred concentrations compared.
//
// Only pairs with a number on both sides enter the agreement: a bound ("< LOD", "> range") says
// where a value isn't, not where it is. Agreement is on the log scale, since inferred
// concentrations span decades and their errors are proportional: the geometric mean ratio
// (CAPTURE-Screen ÷ plate reader) and Bland-Altman 95% limits of agreement on log10 ratios, plus
// how many pairs' 95% CIs overlap. No pass / fail threshold: none until real data says what
// agreement to expect.
//
// Reads CAPTURE-Screen batches through HardwareApi, never writes; stores nothing itself.
// =========================================================

let plateSide = null;   // { source, info, samples: Map(folded name -> SideSample) }
let deviceSide = null;  // same shape, before the dilution below is applied
let exported = false;
let compareChart = null;
// SideSample: { name, n, status: "ok" | "below_lod" | "above_range" | ..., nM, ci: [lo, hi] | null, range: {min, max} }

// ---- Formatting (the site's rules: concentration 1 dp, µM above 1000 nM) -------------------

function formatConcentration(nM) {
  if (nM === null || nM === undefined || !Number.isFinite(nM)) return "--";
  return nM > 1000 ? `${(nM / 1000).toFixed(1)} µM` : `${nM.toFixed(1)} nM`;
}

function formatInterval(ci) {
  return ci ? `${formatConcentration(ci[0])} – ${formatConcentration(ci[1])}` : "--";
}

function formatRatio(ratio) {
  return Number.isFinite(ratio) ? `${ratio.toFixed(2)}×` : "--";
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

function formatLocalDate(utc) {
  const d = new Date(utc);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- Reading the two sides -------------------------------------------------------------

// RFC 4180 CSV (quoted fields, doubled quotes, CRLF), with the UTF-8 BOM both exports write.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((cell) => cell !== ""));
  if (!header) throw new Error("The file is empty.");
  return { header, records: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}

function requireColumns(header, columns, what) {
  const missing = columns.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`Not ${what}: missing column${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`);
}

const num = (text) => (text === "" || text === undefined ? NaN : Number(text));

// One side's samples keyed by name, case-insensitive: the first row per name, since a CSV repeats
// a sample's result on every replicate row.
function sampleMap(entries) {
  const samples = new Map();
  for (const s of entries) {
    const key = s.name.trim().toLowerCase();
    if (!key || samples.has(key)) continue;
    samples.set(key, s);
  }
  return samples;
}

function readPlateCsv(text, filename) {
  const { header, records } = parseCsv(text);
  requireColumns(header, ["strain", "role", "sample", "dilution", "status", "ahl_sample_nM",
    "ci95_sample_low_nM", "ci95_sample_high_nM", "range_min_nM", "range_max_nM"], "a Plate Reader Assay CSV");
  const sampleRows = records.filter((r) => r.role === "sample");
  if (!records.length) throw new Error("The file has no readings.");
  const first = records[0];
  const samples = sampleMap(sampleRows.map((r) => {
    const dilution = num(r.dilution);
    return {
      name: r.sample,
      n: num(r.sample_n),
      status: r.status,
      nM: r.status === "ok" ? num(r.ahl_sample_nM) : null,
      ci: r.status === "ok" ? [num(r.ci95_sample_low_nM), num(r.ci95_sample_high_nM)] : null,
      range: { min: num(r.range_min_nM) * dilution, max: num(r.range_max_nM) * dilution },
    };
  }));
  return {
    source: filename,
    info: {
      strain: first.strain,
      rows: [
        ["File", filename],
        ["Date", first.date || "--"],
        ["Strain", first.strain || "--"],
        ["Signal", first.signal_description || "--"],
        ["Normalization", first.normalization || "--"],
        ["Samples", String(samples.size)],
      ],
    },
    samples,
  };
}

function readBatchCsv(text, filename) {
  const { header, records } = parseCsv(text);
  requireColumns(header, ["batch_id", "sensor", "role", "sample_name", "estimate_status", "inferred_nM",
    "ci95_low_nM", "ci95_high_nM", "curve_range_min_nM", "curve_range_max_nM"], "a CAPTURE-Screen batch CSV");
  if (!records.length) throw new Error("The file has no tubes.");
  const first = records[0];
  const samples = sampleMap(records.filter((r) => r.role === "sample").map((r) => ({
    name: r.sample_name,
    n: num(r.group_n),
    status: r.estimate_status,
    nM: r.estimate_status === "ok" ? num(r.inferred_nM) : null,
    ci: r.estimate_status === "ok" ? [num(r.ci95_low_nM), num(r.ci95_high_nM)] : null,
    range: { min: num(r.curve_range_min_nM), max: num(r.curve_range_max_nM) },
  })));
  return {
    source: filename,
    info: {
      strain: first.sensor,
      rows: [["File", filename], ["Batch", first.batch_id], ["Strain", first.sensor || "--"], ["Samples", String(samples.size)]],
    },
    samples,
  };
}

function readBatch(batch) {
  const samples = sampleMap(batch.samples.map((s) => ({
    name: s.name,
    n: s.estimate.n,
    status: s.estimate.status,
    nM: s.estimate.status === "ok" ? s.estimate.concentration_nM : null,
    ci: s.estimate.status === "ok" ? s.estimate.ci95_nM : null,
    range: batch.curve.range_nM,
  })));
  return {
    source: batch.batch_id,
    info: {
      strain: batch.curve.conditions.sensor,
      rows: [
        ["Batch", batch.batch_id],
        ["Created", formatLocalDate(batch.created_at)],
        ["Finished", batch.finished_at ? formatLocalDate(batch.finished_at) : "Not finished"],
        ["Strain", batch.curve.conditions.sensor],
        ["Curve", batch.curve_id],
        ["Samples", String(samples.size)],
      ],
    },
    samples,
  };
}

function renderSummary(tbodyId, side) {
  const tbody = document.getElementById(tbodyId);
  tbody.replaceChildren();
  tbody.closest(".table-wrapper").hidden = !side;
  if (!side) return;
  for (const [label, value] of side.info.rows) {
    const tr = el("tr");
    tr.append(Object.assign(el("th", null, label), { scope: "row" }), el("td", null, value));
    tbody.appendChild(tr);
  }
}

async function loadFile(input, reader, assign, statusEl, summaryId) {
  const file = input.files[0];
  if (!file) return;
  try {
    const side = reader(await file.text(), file.name);
    assign(side);
    setStatus(statusEl, `Read ${plural(side.samples.size, "sample")} from ${file.name}.`, "success");
  } catch (err) {
    assign(null);
    setStatus(statusEl, `Could not read ${file.name}: ${err.message}`, "error");
  }
  exported = false;
  renderSummary(summaryId, summaryId === "plate-summary" ? plateSide : deviceSide);
  render();
}

async function loadBatchChoice() {
  const id = document.getElementById("batch-select").value;
  const statusEl = document.getElementById("device-status");
  if (!id) {
    deviceSide = null;
    setStatus(statusEl, "", null);
  } else {
    document.getElementById("batch-file").value = "";
    try {
      deviceSide = readBatch(await HardwareApi.getBatch(id));
      setStatus(statusEl, `Read ${plural(deviceSide.samples.size, "sample")} from ${id}.`, "success");
    } catch (err) {
      deviceSide = null;
      setStatus(statusEl, `Could not read ${id}: ${err.message}`, "error");
    }
  }
  exported = false;
  renderSummary("device-summary", deviceSide);
  render();
}

async function fillBatchSelect() {
  const select = document.getElementById("batch-select");
  const none = el("option", null, "Choose a batch");
  none.value = "";
  select.replaceChildren(none);
  try {
    const batches = await HardwareApi.listBatches();
    for (const b of batches) {
      const option = el("option", null, `${b.batch_id} · ${b.conditions.sensor} · ${plural(b.samples, "sample")} · ${formatLocalDate(b.created_at)}`);
      option.value = b.batch_id;
      select.appendChild(option);
    }
    if (batches.length === 0) none.textContent = "No batches in this browser";
  } catch (err) {
    none.textContent = `Batches unavailable: ${err.message}`;
  }
}

// ---- Comparing ------------------------------------------------------------------------

function deviceDilution() {
  const text = document.getElementById("device-dilution").value.trim();
  const value = text === "" ? NaN : Number(text);
  return value >= 1 ? value : null;
}

// Every name on either side, in the plate reader's order then the rest, with CAPTURE-Screen's
// values scaled by its dilution.
function pairs() {
  const dilution = deviceDilution();
  const scale = (s) => (s ? {
    ...s,
    nM: s.nM === null ? null : s.nM * dilution,
    ci: s.ci ? s.ci.map((v) => v * dilution) : null,
    range: { min: s.range.min * dilution, max: s.range.max * dilution },
  } : null);
  const keys = [...new Set([...plateSide.samples.keys(), ...deviceSide.samples.keys()])];
  return keys.map((key) => {
    const plate = plateSide.samples.get(key) ?? null;
    const device = scale(deviceSide.samples.get(key) ?? null);
    const both = plate?.status === "ok" && device?.status === "ok";
    return {
      name: (plate ?? device).name,
      plate,
      device,
      both,
      ratio: both ? device.nM / plate.nM : null,
      overlap: both ? plate.ci[0] <= device.ci[1] && device.ci[0] <= plate.ci[1] : null,
    };
  });
}

// Geometric mean ratio and Bland-Altman limits on log10(CAPTURE-Screen / plate reader).
function agreement(compared) {
  const logs = compared.map((p) => Math.log10(p.ratio));
  const n = logs.length;
  if (n === 0) return null;
  const mean = logs.reduce((a, b) => a + b, 0) / n;
  const sd = n >= 2 ? Math.sqrt(logs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1)) : null;
  return {
    n,
    gmr: 10 ** mean,
    loa: sd === null ? null : [10 ** (mean - 1.96 * sd), 10 ** (mean + 1.96 * sd)],
    overlap: compared.filter((p) => p.overlap).length,
  };
}

function formatSide(s) {
  if (!s) return "Not measured";
  if (s.status === "ok") return formatConcentration(s.nM);
  if (s.status === "below_lod") return `< ${formatConcentration(s.range.min)}`;
  if (s.status === "above_range") return `> ${formatConcentration(s.range.max)}`;
  return "No result";
}

function renderComparison() {
  const all = pairs();
  const compared = all.filter((p) => p.both);
  const stats = agreement(compared);
  const set = (id, text) => { document.getElementById(id).textContent = text; };

  const warnings = [];
  const strain = (s) => s.info.strain.trim().toLowerCase();
  if (strain(plateSide) && strain(deviceSide) && strain(plateSide) !== strain(deviceSide)) {
    warnings.push(`Different strains: ${plateSide.info.strain} (plate reader), ${deviceSide.info.strain} (CAPTURE-Screen). The comparison assumes one biosensor.`);
  }
  if (!all.some((p) => p.plate && p.device)) warnings.push("No sample name appears on both sides. Samples are paired by name.");
  const warningEl = document.getElementById("compare-warning");
  setStatus(warningEl, warnings.join(" "), "warn");
  warningEl.hidden = warnings.length === 0;

  set("stat-pairs", stats ? String(stats.n) : "0");
  set("stat-pairs-sub", `of ${plural(all.length, "sample")}; a number on both sides`);
  set("stat-ratio", stats ? formatRatio(stats.gmr) : "--");
  set("stat-loa", stats?.loa ? `${formatRatio(stats.loa[0])} – ${formatRatio(stats.loa[1])}` : "--");
  set("stat-overlap", stats ? `${stats.overlap} / ${stats.n}` : "--");
  set("stat-overlap-sub", stats && !stats.loa ? "Limits need at least 2 pairs" : "pairs");

  const tbody = document.getElementById("compare-body");
  tbody.replaceChildren();
  for (const p of all) {
    const tr = el("tr");
    tr.append(
      el("td", null, p.name),
      el("td", null, formatSide(p.plate)),
      el("td", null, formatInterval(p.plate?.ci)),
      el("td", null, formatSide(p.device)),
      el("td", null, formatInterval(p.device?.ci)),
      el("td", null, formatRatio(p.ratio)),
      el("td", null, p.overlap === null ? "--" : p.overlap ? "Yes" : "No"),
    );
    tbody.appendChild(tr);
  }

  const onlyPlate = all.filter((p) => !p.device).map((p) => p.name);
  const onlyDevice = all.filter((p) => !p.plate).map((p) => p.name);
  const unmatched = document.getElementById("compare-unmatched");
  const parts = [];
  if (onlyPlate.length) parts.push(`Only on the plate reader: ${onlyPlate.join(", ")}.`);
  if (onlyDevice.length) parts.push(`Only on CAPTURE-Screen: ${onlyDevice.join(", ")}.`);
  unmatched.textContent = parts.join(" ");
  unmatched.hidden = parts.length === 0;

  renderChart(compared);
  return { all, stats };
}

// 95% CI bars in both directions: each point carries xLo / xHi / yLo / yHi.
const ciBarPlugin = {
  id: "compareCiBars",
  afterDatasetsDraw(chart) {
    const { ctx, scales } = chart;
    const dataset = chart.data.datasets[0];
    if (!dataset || !chart.isDatasetVisible(0)) return;
    ctx.save();
    ctx.strokeStyle = dataset.borderColor;
    ctx.lineWidth = 1.2;
    for (const p of dataset.data) {
      const x = scales.x.getPixelForValue(p.x);
      const y = scales.y.getPixelForValue(p.y);
      const [x1, x2] = [scales.x.getPixelForValue(p.xLo), scales.x.getPixelForValue(p.xHi)];
      const [y1, y2] = [scales.y.getPixelForValue(p.yLo), scales.y.getPixelForValue(p.yHi)];
      ctx.beginPath();
      ctx.moveTo(x1, y); ctx.lineTo(x2, y);
      ctx.moveTo(x, y1); ctx.lineTo(x, y2);
      ctx.moveTo(x1, y - 4); ctx.lineTo(x1, y + 4);
      ctx.moveTo(x2, y - 4); ctx.lineTo(x2, y + 4);
      ctx.moveTo(x - 4, y1); ctx.lineTo(x + 4, y1);
      ctx.moveTo(x - 4, y2); ctx.lineTo(x + 4, y2);
      ctx.stroke();
    }
    ctx.restore();
  },
};

function renderChart(compared) {
  if (compareChart) compareChart.destroy();
  compareChart = null;
  const accent = cssVar("--accent");
  const ink = cssVar("--text");
  const muted = cssVar("--muted");
  const rule = cssVar("--border");
  const gold = cssVar("--gold");

  const points = compared.map((p) => ({
    x: p.plate.nM, y: p.device.nM, name: p.name,
    xLo: p.plate.ci[0], xHi: p.plate.ci[1], yLo: p.device.ci[0], yHi: p.device.ci[1],
  }));
  const values = points.flatMap((p) => [p.xLo, p.xHi, p.yLo, p.yHi]).filter((v) => v > 0);
  const lo = values.length ? 10 ** Math.floor(Math.log10(Math.min(...values))) : 1;
  const hi = values.length ? 10 ** Math.ceil(Math.log10(Math.max(...values))) : 1000;

  compareChart = new Chart(document.getElementById("compare-chart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "Sample", data: points, pointRadius: 4, pointBackgroundColor: accent, pointBorderColor: accent, borderColor: accent },
        {
          label: "y = x", data: [{ x: lo, y: lo }, { x: hi, y: hi }], type: "line",
          pointRadius: 0, borderWidth: 1.5, borderDash: [6, 4], borderColor: gold,
        },
      ],
    },
    options: {
      responsive: true,
      aspectRatio: 1.4,
      animation: false,
      scales: {
        x: {
          type: "logarithmic", min: lo, max: hi,
          title: { display: true, text: "Plate reader: AHL in sample (nM)", color: ink },
          grid: { color: rule }, ticks: { color: muted },
        },
        y: {
          type: "logarithmic", min: lo, max: hi,
          title: { display: true, text: "CAPTURE-Screen: AHL in sample (nM)", color: ink },
          grid: { color: rule }, ticks: { color: muted },
        },
      },
      plugins: {
        legend: { labels: { color: ink } },
        tooltip: {
          callbacks: {
            label: (item) => (item.datasetIndex === 0
              ? `${item.raw.name}: ${formatConcentration(item.raw.x)} vs ${formatConcentration(item.raw.y)}`
              : "y = x"),
          },
        },
      },
    },
    plugins: [ciBarPlugin],
  });
}

// ---- Export ---------------------------------------------------------------------------

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
  "sample", "plate_source", "plate_strain", "plate_status", "plate_nM", "plate_ci95_low_nM", "plate_ci95_high_nM",
  "device_source", "device_strain", "device_dilution", "device_status", "device_nM", "device_ci95_low_nM", "device_ci95_high_nM",
  "ratio_device_over_plate", "ci95_overlap", "pairs_compared", "geometric_mean_ratio", "loa95_low", "loa95_high",
];

// A row per sample, the agreement beside each; full precision.
function exportCsv() {
  const { all, stats } = renderComparison();
  const dilution = deviceDilution();
  const rows = all.map((p) => [
    p.name, plateSide.source, plateSide.info.strain, p.plate?.status ?? "not_measured", p.plate?.nM, p.plate?.ci?.[0], p.plate?.ci?.[1],
    deviceSide.source, deviceSide.info.strain, dilution, p.device?.status ?? "not_measured", p.device?.nM, p.device?.ci?.[0], p.device?.ci?.[1],
    p.ratio, p.overlap, stats?.n ?? 0, stats?.gmr, stats?.loa?.[0], stats?.loa?.[1],
  ]);
  const text = [CSV_HEADERS, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `cross-validation-${stamp}.csv`;
  downloadBlob(name, new Blob([`﻿${text}\r\n`], { type: "text/csv;charset=utf-8" }));
  exported = true;
  setStatus(document.getElementById("export-status"), `Exported ${name}.`, "success");
  renderCards();
}

function exportPng() {
  const source = document.getElementById("compare-chart");
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  const name = `cross-validation-${new Date().toISOString().slice(0, 10)}.png`;
  canvas.toBlob((blob) => {
    downloadBlob(name, blob);
    setStatus(document.getElementById("export-status"), `Exported ${name}.`, "success");
  }, "image/png");
}

// ---- Rendering ------------------------------------------------------------------------

function renderCards() {
  const dilutionOk = deviceDilution() !== null;
  setStepCard(document.getElementById("plate-card"), plateSide ? "done" : "current");
  setStepCard(document.getElementById("device-card"), deviceSide && dilutionOk ? "done" : "current");
  const ready = plateSide && deviceSide && dilutionOk;
  const waitFor = !plateSide ? "Load the plate reader results first."
    : !deviceSide ? "Choose a CAPTURE-Screen batch first."
      : "Dilution must be a number ≥ 1.";
  setStepCard(document.getElementById("compare-card"), ready ? "done" : "waiting", waitFor);
  setStepCard(document.getElementById("export-card"), ready ? (exported ? "done" : "current") : "waiting", waitFor);
}

function render() {
  const dilutionInput = document.getElementById("device-dilution");
  const dilutionOk = deviceDilution() !== null;
  dilutionInput.classList.toggle("is-missing", !dilutionOk);
  dilutionInput.setAttribute("aria-invalid", String(!dilutionOk));
  renderCards();
  if (plateSide && deviceSide && dilutionOk) renderComparison();
}

document.addEventListener("DOMContentLoaded", () => {
  const plateInput = document.getElementById("plate-file");
  plateInput.addEventListener("change", () => loadFile(plateInput, readPlateCsv,
    (side) => { plateSide = side; }, document.getElementById("plate-status"), "plate-summary"));
  const batchInput = document.getElementById("batch-file");
  batchInput.addEventListener("change", () => {
    document.getElementById("batch-select").value = "";
    loadFile(batchInput, readBatchCsv, (side) => { deviceSide = side; }, document.getElementById("device-status"), "device-summary");
  });
  document.getElementById("batch-select").addEventListener("change", loadBatchChoice);
  document.getElementById("device-dilution").addEventListener("input", () => {
    exported = false;
    render();
  });
  document.getElementById("export-csv").addEventListener("click", exportCsv);
  document.getElementById("export-png").addEventListener("click", exportPng);
  window.addEventListener("beforeunload", (event) => {
    if (!plateSide || !deviceSide || exported) return;
    event.preventDefault();
    event.returnValue = "";
  });

  fillBatchSelect();
  render();
});
