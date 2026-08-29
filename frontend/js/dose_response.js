// =========================================================
// 對接 index.html 裡「AHL Dose-Response Analysis」區塊
// 目標元素：
//   #dose-response-form / #dose-response-file / #analyze-button
//   #dose-response-status
//   #dose-response-result / #results-table-body / #strain-charts
// 對接 API：
//   POST /api/dose_response/analyze（回傳 {strains: {strain名: {...}}}）
//   POST /api/dose_response/predict（每株菌結果區塊裡的反推小工具用）
// 依賴 js/config.js 的全域 BACKEND_BASE_URL，這支必須排在它後面載入。
// =========================================================

// strain -> Chart 實例，重新分析時要先 destroy 舊的，避免 canvas 殘留舊圖層。
const strainCharts = {};

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
  // responsive=False：不畫假的劑量反應曲線（沒有 fit_curve 可畫），只留一句診斷訊息。
  if (!result.responsive || !result.fit_curve) {
    const message = document.createElement("p");
    message.className = "status-message";
    message.textContent = "No significant dose-response detected.";
    return message;
  }

  const canvas = document.createElement("canvas");
  canvas.id = `chart-${strain}`;
  canvas.height = 260;

  // Chart.js 的對數 x 軸畫不出 x=0，跟舊版 4PL 圖表一樣把 0 nM（負對照）那個點濾掉，
  // 摘要表格裡還是看得到每株菌的完整結果，只有這張圖不畫。
  const scatterPoints = result.plateau_points
    .filter(([x]) => x > 0)
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
          pointBackgroundColor: "#075a3e",
          pointBorderColor: "#075a3e",
        },
        {
          label: "Hill fit",
          data: curvePoints,
          type: "line",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0,
          borderColor: "#c9a227",
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
          borderColor: "#a3382c",
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: {
          type: "logarithmic",
          title: { display: true, text: "Concentration (nM)", color: "#4a3f35" },
          grid: { color: "#e0d6c0" },
          ticks: { color: "#6b6055" },
        },
        y: {
          title: { display: true, text: "Normalized fluorescence (F)", color: "#4a3f35" },
          grid: { color: "#e0d6c0" },
          ticks: { color: "#6b6055" },
        },
      },
      plugins: {
        legend: { labels: { color: "#4a3f35" } },
      },
    },
  });

  return canvas;
}

// 螢光 -> 濃度反推小工具，每個 responsive 的菌株一份，直接沿用 /analyze
// 給的 Hill 參數（bottom/top/ec50_nM/n/ec50_nM_ci95），不用另外存 session。
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
        // 後端已經給了說明訊息（例如低於偵測下限），直接顯示，不要顯示 null 或報錯。
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

    // responsive=False：沒有可信的曲線可以反推，不提供這個小工具。
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
