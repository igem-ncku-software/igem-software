// =========================================================
// Backs the analysis section of dose-response.html
// Target elements:
//   #dose-response-form / #dose-response-file / #analyze-button
//   #dose-response-status
//   #dose-response-result / #results-table-body / #strain-charts
// Backing API:
//   POST /api/dose_response/analyze (returns {strains: {strain_name: {...}}})
//   POST /api/dose_response/predict (used by the inversion widget in each strain's result block)
// Depends on js/config.js's global BACKEND_BASE_URL, so this must load after it.
// =========================================================

// strain -> Chart instance; the old one must be destroy()ed before re-analyzing, to avoid stale layers left on the canvas.
const strainCharts = {};

// Chart.js needs an actual color code and can't consume a CSS variable directly, so it's
// read out here. This keeps css/style.css's :root as the one source of truth for colors —
// changing the palette updates the charts too, instead of having to edit both places
// (this used to be hardcoded literals that could drift out of sync with the stylesheet).
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setDoseResponseStatus(text, kind) {
  const el = document.getElementById("dose-response-status");
  if (!el) return;

  el.textContent = text;
  el.className = "status-message" + (kind ? ` ${kind}` : "");
}

function formatNumber(value, digits = 2) {
  return value === null || value === undefined ? "--" : value.toFixed(digits);
}

function formatCI(ci) {
  if (!ci) return "--";
  const [lo, hi] = ci;
  return `(${lo.toFixed(2)}, ${hi.toFixed(2)})`;
}

function renderResultsTable(strains) {
  const tbody = document.getElementById("results-table-body");
  tbody.innerHTML = "";

  for (const [strain, result] of Object.entries(strains)) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${strain}</td>
      <td>${formatNumber(result.ec50_nM)}</td>
      <td>${formatCI(result.ec50_nM_ci95)}</td>
      <td>${formatNumber(result.n, 3)}</td>
      <td>${formatNumber(result.r_squared, 4)}</td>
      <td class="${result.responsive ? "significance-cell" : ""}">${result.responsive ? "Yes" : "No"}</td>
      <td>${formatNumber(result.lod_nM, 1)}</td>
      <td>${formatNumber(result.loq_nM, 1)}</td>
    `;
    tbody.appendChild(row);
  }
}

function renderStrainChart(strain, result) {
  // responsive=False: no fake dose-response curve is drawn (there's no fit_curve to draw), just a one-line diagnostic message.
  if (!result.responsive || !result.fit_curve) {
    const message = document.createElement("p");
    message.className = "status-message";
    message.textContent = "No significant dose-response detected.";
    return message;
  }

  // canvas.height is left unset: Chart.js ignores aspectRatio as soon as the canvas has a
  // hardcoded height, stretching the chart into a mostly-empty block as wide as the card.
  // Height is instead controlled by the aspectRatio set below.
  const canvas = document.createElement("canvas");
  canvas.id = `chart-${strain}`;

  // The chart sits on an opaque .chart-plate rather than the glass panel style: curves and
  // gridlines over a blurred panel would be hard to read, so glass is reserved for the frame only.
  const plate = document.createElement("div");
  plate.className = "chart-plate";
  plate.appendChild(canvas);

  const accent = cssVar("--accent");
  const gold = cssVar("--gold");
  const error = cssVar("--error");
  const ink = cssVar("--text");
  const muted = cssVar("--muted");
  const rule = cssVar("--border");

  // Chart.js's logarithmic x-axis can't plot x=0, so — same as the old 4PL chart — the 0 nM
  // (negative control) point is filtered out here; the summary table still shows every
  // strain's full result, only this chart skips it.
  // A null plateau means every reading at that concentration was excluded by OD gating, so there's no point to draw.
  const scatterPoints = result.plateau_points
    .filter(([x, y]) => x > 0 && Number.isFinite(y))
    .map(([x, y]) => ({ x, y }));
  const curvePoints = result.fit_curve.map(([x, y]) => ({ x, y }));

  const allY = [...scatterPoints, ...curvePoints].map((p) => p.y);
  const yMin = Math.min(...allY);
  const yMax = Math.max(...allY);

  strainCharts[strain] = new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Plateau (measured)",
          data: scatterPoints,
          pointRadius: 5,
          showLine: false,
          pointBackgroundColor: accent,
          pointBorderColor: accent,
        },
        {
          label: "Hill fit",
          data: curvePoints,
          type: "line",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0,
          borderColor: gold,
        },
        {
          label: "EC50",
          data: [
            { x: result.ec50_nM, y: yMin },
            { x: result.ec50_nM, y: yMax },
          ],
          type: "line",
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [6, 4],
          borderColor: error,
        },
      ],
    },
    options: {
      responsive: true,
      // Without this Chart.js derives the ratio from the canvas element's own
      // width/height, which on a full-width card renders a ~800px-tall plot
      // that is almost entirely empty space.
      aspectRatio: 2.6,
      scales: {
        x: {
          type: "logarithmic",
          title: { display: true, text: "Concentration (nM)", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
        y: {
          title: { display: true, text: "Normalized fluorescence (F)", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
      },
      plugins: {
        legend: { labels: { color: ink } },
      },
    },
  });

  return plate;
}

// Fluorescence -> concentration inversion widget, one per responsive strain, reusing the
// Hill params (bottom/top/ec50_nM/n/ec50_nM_ci95) /analyze already returned — no separate session storage needed.
function buildPredictWidget(strain, result) {
  const form = document.createElement("form");
  form.className = "predict-form";

  const label = document.createElement("label");
  label.textContent = `Predict [AHL] from a measured F (${strain})`;
  form.appendChild(label);

  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.required = true;
  input.placeholder = "Normalized fluorescence (F)";
  form.appendChild(input);

  const button = document.createElement("button");
  button.type = "submit";
  button.className = "btn-secondary";
  button.textContent = "Predict concentration";
  form.appendChild(button);

  const output = document.createElement("p");
  output.className = "status-message";
  form.appendChild(output);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const fluorescence = Number(input.value);
    if (Number.isNaN(fluorescence)) {
      output.textContent = "Enter a numeric F value first.";
      output.className = "status-message error";
      return;
    }

    button.disabled = true;
    output.textContent = "Predicting...";
    output.className = "status-message";

    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/dose_response/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strain,
          fluorescence,
          hill_params: {
            bottom: result.bottom,
            top: result.top,
            ec50_nM: result.ec50_nM,
            n: result.n,
            ec50_nM_ci95: result.ec50_nM_ci95,
          },
        }),
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        throw new Error(errorBody?.detail || `HTTP ${res.status}`);
      }

      const prediction = await res.json();

      if (!prediction.in_range) {
        // The backend already provides an explanatory message (e.g. below the detection limit); show it as-is instead of null or a generic error.
        output.textContent = prediction.message || "Fluorescence value is out of the predictable range.";
        output.className = "status-message error";
        return;
      }

      const ci = prediction.concentration_nM_ci95;
      const ciText = ci ? ` (95% CI: ${ci[0].toFixed(2)}–${ci[1].toFixed(2)} nM)` : "";
      output.textContent = `Predicted [AHL]: ${prediction.concentration_nM.toFixed(2)} nM${ciText}`;
      output.className = "status-message success";
    } catch (err) {
      console.error("Prediction failed:", err);
      output.textContent = `Prediction failed: ${err.message}`;
      output.className = "status-message error";
    } finally {
      button.disabled = false;
    }
  });

  return form;
}

function renderStrainCharts(strains) {
  const container = document.getElementById("strain-charts");

  for (const chart of Object.values(strainCharts)) chart.destroy();
  for (const key of Object.keys(strainCharts)) delete strainCharts[key];
  container.innerHTML = "";

  for (const [strain, result] of Object.entries(strains)) {
    const block = document.createElement("div");
    block.className = "result-block";

    const heading = document.createElement("h3");
    heading.className = "subsection-heading";
    heading.textContent = strain;
    block.appendChild(heading);

    if (result.responsive) {
      const note = document.createElement("p");
      note.className = "chart-note";
      note.textContent = "Log scale on the concentration axis. Dashed line marks EC50.";
      block.appendChild(note);
    }

    block.appendChild(renderStrainChart(strain, result));

    // responsive=False: there's no trustworthy curve to invert against, so this widget isn't offered.
    if (result.responsive) {
      const predictBlock = document.createElement("div");
      predictBlock.className = "result-block";
      predictBlock.appendChild(buildPredictWidget(strain, result));
      block.appendChild(predictBlock);
    }

    container.appendChild(block);
  }
}

async function analyzeUpload(file) {
  const formData = new FormData();
  formData.append("file", file);

  const button = document.getElementById("analyze-button");
  button.disabled = true;
  setDoseResponseStatus("Analyzing...", null);

  try {
    const res = await fetch(`${BACKEND_BASE_URL}/api/dose_response/analyze`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      throw new Error(errorBody?.detail || `HTTP ${res.status}`);
    }

    const { strains } = await res.json();
    document.getElementById("dose-response-result").hidden = false;
    renderResultsTable(strains);
    renderStrainCharts(strains);
    setDoseResponseStatus(`Analysis complete — ${Object.keys(strains).length} strain(s).`, "success");
  } catch (err) {
    console.error("Dose-response analysis failed:", err);
    setDoseResponseStatus(`Analysis failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("dose-response-form").addEventListener("submit", (event) => {
    event.preventDefault();

    const file = document.getElementById("dose-response-file").files[0];
    if (!file) {
      setDoseResponseStatus("Please choose a file first.", "error");
      return;
    }

    analyzeUpload(file);
  });
});
