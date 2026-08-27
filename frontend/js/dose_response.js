// =========================================================
// 對接 index.html 裡「AHL Dose-Response (4PL) Analysis」區塊
// 目標元素：
//   #dose-response-form / #dose-response-data / #fix-bottom / #analyze-button
//   #sim-top / #sim-bottom / #sim-ec50 / #sim-hill / #sim-noise / #sim-replicates / #simulate-button
//   #dose-response-status
//   #dose-response-result / #result-ec50 / #result-hill / #result-top / #result-bottom
//   #result-r2 / #result-converged / #result-warnings
//   #dose-response-chart（canvas）
// =========================================================

const DOSE_RESPONSE_BACKEND_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ? "http://127.0.0.1:8000"
  : "https://igem-ncku-software.onrender.com";

let doseResponseChart = null;

function parseDataTextarea(text) {
  const concentrations = [];
  const responses = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split(",");
    if (parts.length !== 2) {
      throw new Error(`Cannot parse line "${line}" — expected "concentration, response".`);
    }

    const concentration = Number(parts[0].trim());
    const response = Number(parts[1].trim());

    if (Number.isNaN(concentration) || Number.isNaN(response)) {
      throw new Error(`Cannot parse line "${line}" — expected two numbers.`);
    }

    concentrations.push(concentration);
    responses.push(response);
  }

  if (concentrations.length === 0) {
    throw new Error("No data points to analyze.");
  }

  return { concentrations, responses };
}

function formatDataForTextarea(concentrations, responses) {
  return concentrations.map((c, i) => `${c}, ${responses[i].toFixed(2)}`).join("\n");
}

function setDoseResponseStatus(text, kind) {
  const el = document.getElementById("dose-response-status");
  if (!el) return;

  el.textContent = text;
  el.className = "status-message" + (kind ? ` ${kind}` : "");
}

function renderDoseResponseResult(result) {
  document.getElementById("dose-response-result").hidden = false;

  document.getElementById("result-ec50").textContent = result.params.ec50.toFixed(3);
  document.getElementById("result-hill").textContent = result.params.hill_slope.toFixed(3);
  document.getElementById("result-top").textContent = result.params.top.toFixed(2);
  document.getElementById("result-bottom").textContent = result.params.bottom.toFixed(2);
  document.getElementById("result-r2").textContent =
    result.r_squared === null ? "--" : result.r_squared.toFixed(4);
  document.getElementById("result-converged").textContent = result.converged ? "Yes" : "No";

  const warningsEl = document.getElementById("result-warnings");
  warningsEl.innerHTML = "";
  for (const warning of result.warnings) {
    const li = document.createElement("li");
    li.textContent = warning;
    warningsEl.appendChild(li);
  }

  renderDoseResponseChart(result.chart_data);
}

function renderDoseResponseChart(chartData) {
  const canvas = document.getElementById("dose-response-chart");
  if (!canvas || typeof Chart === "undefined") return;

  // Chart.js's logarithmic x scale can't place x=0, so it's dropped here —
  // the 0-concentration (negative control) point still shows in the summary
  // stats and raw data table, just not on this plot.
  const scatterPoints = chartData.scatter.filter((p) => p.x > 0);
  const curvePoints = chartData.curve.filter((p) => p.x > 0);

  const allY = [...scatterPoints, ...curvePoints].map((p) => p.y);
  const yMin = Math.min(...allY);
  const yMax = Math.max(...allY);

  if (doseResponseChart) {
    doseResponseChart.destroy();
  }

  doseResponseChart = new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Raw data",
          data: scatterPoints,
          pointRadius: 4,
          showLine: false,
        },
        {
          label: "4PL fit",
          data: curvePoints,
          type: "line",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0,
        },
        {
          label: "EC50",
          data: [
            { x: chartData.ec50, y: yMin },
            { x: chartData.ec50, y: yMax },
          ],
          type: "line",
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [6, 4],
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { type: "logarithmic", title: { display: true, text: "Concentration" } },
        y: { title: { display: true, text: "Response" } },
      },
    },
  });
}

async function analyzeDoseResponse() {
  let concentrations, responses;

  try {
    ({ concentrations, responses } = parseDataTextarea(
      document.getElementById("dose-response-data").value
    ));
  } catch (err) {
    setDoseResponseStatus(err.message, "error");
    return;
  }

  const fixBottomRaw = document.getElementById("fix-bottom").value.trim();
  const fixBottom = fixBottomRaw === "" ? null : Number(fixBottomRaw);

  const button = document.getElementById("analyze-button");
  button.disabled = true;
  setDoseResponseStatus("Analyzing...", null);

  try {
    const res = await fetch(`${DOSE_RESPONSE_BACKEND_URL}/api/dose_response/fit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concentrations, responses, fix_bottom: fixBottom }),
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      throw new Error(errorBody?.detail || `HTTP ${res.status}`);
    }

    const result = await res.json();
    renderDoseResponseResult(result);
    setDoseResponseStatus(
      result.converged ? "Fit converged." : "Fit did not converge — see warnings below.",
      result.converged ? "success" : "error"
    );
  } catch (err) {
    console.error("Dose-response analysis failed:", err);
    setDoseResponseStatus(`Analysis failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function generateSimulatedData() {
  const payload = {
    top: Number(document.getElementById("sim-top").value),
    bottom: Number(document.getElementById("sim-bottom").value),
    ec50: Number(document.getElementById("sim-ec50").value),
    hill_slope: Number(document.getElementById("sim-hill").value),
    noise_sd: Number(document.getElementById("sim-noise").value),
    n_replicates: Number(document.getElementById("sim-replicates").value),
  };

  const button = document.getElementById("simulate-button");
  button.disabled = true;
  setDoseResponseStatus("Generating simulated data...", null);

  try {
    const res = await fetch(`${DOSE_RESPONSE_BACKEND_URL}/api/dose_response/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      throw new Error(errorBody?.detail || `HTTP ${res.status}`);
    }

    const { concentrations, responses } = await res.json();
    document.getElementById("dose-response-data").value = formatDataForTextarea(
      concentrations,
      responses
    );
    setDoseResponseStatus("Simulated data generated — analyzing...", null);

    await analyzeDoseResponse();
  } catch (err) {
    console.error("Simulated data generation failed:", err);
    setDoseResponseStatus(`Failed to generate simulated data: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("dose-response-form").addEventListener("submit", (event) => {
    event.preventDefault();
    analyzeDoseResponse();
  });

  document.getElementById("simulate-button").addEventListener("click", generateSimulatedData);
});
