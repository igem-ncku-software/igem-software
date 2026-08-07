const BACKEND_URL = "https://igem-ncku-software.onrender.com";

// ========================================
// Shared DOM
// ========================================

const backendStatus = document.getElementById("backend-status");
const esp32RecordsContainer = document.getElementById("esp32-records");

// ========================================
// Fluorescence CSV analysis
// ========================================

const fluorescenceForm = document.getElementById("fluorescence-form");
const fluorescenceFileInput = document.getElementById(
  "fluorescence-file"
);
const fluorescenceSubmit = document.getElementById(
  "fluorescence-submit"
);
const fluorescenceStatus = document.getElementById(
  "fluorescence-status"
);
const fluorescenceSummary = document.getElementById(
  "fluorescence-summary"
);
const fluorescenceSummaryContent = document.getElementById(
  "fluorescence-summary-content"
);
const fluorescenceChartSection = document.getElementById(
  "fluorescence-chart-section"
);
const fluorescenceResults = document.getElementById(
  "fluorescence-results"
);
const fluorescenceResultsBody = document.getElementById(
  "fluorescence-results-body"
);

let fluorescenceChartInstance = null;

fluorescenceForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = fluorescenceFileInput.files[0];

  if (!file) {
    showStatus(
      fluorescenceStatus,
      "Please select a CSV file first.",
      "error"
    );
    return;
  }

  if (!file.name.toLowerCase().endsWith(".csv")) {
    showStatus(
      fluorescenceStatus,
      "Only CSV files are supported.",
      "error"
    );
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  fluorescenceSubmit.disabled = true;

  showStatus(
    fluorescenceStatus,
    "Analyzing, please wait..."
  );

  fluorescenceSummary.hidden = true;
  fluorescenceChartSection.hidden = true;
  fluorescenceResults.hidden = true;
  fluorescenceResultsBody.innerHTML = "";

  try {
    const response = await fetch(
      `${BACKEND_URL}/api/fluorescence/analyze`,
      {
        method: "POST",
        body: formData,
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.detail || `HTTP ${response.status}`
      );
    }

    renderSummary(data.summary);
    renderChart(data.chart_data);
    renderResults(data.results);

    fluorescenceSummary.hidden = false;
    fluorescenceResults.hidden = false;

    showStatus(
      fluorescenceStatus,
      "Analysis complete.",
      "success"
    );
  } catch (error) {
    showStatus(
      fluorescenceStatus,
      `Analysis failed: ${error.message}`,
      "error"
    );
  } finally {
    fluorescenceSubmit.disabled = false;
  }
});

// ========================================
// Render fluorescence summary
// ========================================

function renderSummary(summary) {
  const items = [
    [
      "File name",
      summary.original_file_name
        || summary.file_name
        || "-"
    ],
    [
      "Total rows",
      summary.total_rows ?? "-"
    ],
    [
      "Groups",
      summary.groups ?? "-"
    ],
    [
      "Control",
      summary.control_group || "-"
    ],
    [
      "Control mean GFP / OD600",
      formatNumber(
        summary.control_mean_normalized_gfp
      )
    ],
  ];

  fluorescenceSummaryContent.innerHTML = "";

  items.forEach(([label, value]) => {
    const item = document.createElement("div");
    item.className = "summary-item";

    const labelElement = document.createElement("span");
    labelElement.className = "summary-label";
    labelElement.textContent = label;

    const valueElement = document.createElement("strong");
    valueElement.textContent = value;

    item.append(
      labelElement,
      valueElement
    );

    fluorescenceSummaryContent.appendChild(item);
  });
}

// ========================================
// Render inhibition rate comparison chart (Chart.js)
// ========================================

function renderChart(chartData) {
  if (!chartData || !Array.isArray(chartData.labels)) {
    fluorescenceChartSection.hidden = true;
    return;
  }

  const canvas = document.getElementById("fluorescence-chart");

  if (fluorescenceChartInstance) {
    fluorescenceChartInstance.destroy();
  }

  // Append the significance marker directly to the x-axis label
  const labelsWithSignificance = chartData.labels.map(
    (label, index) => {
      const sig = chartData.significance[index];
      return sig && sig !== "ns" ? `${label} ${sig}` : label;
    }
  );

  fluorescenceChartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels: labelsWithSignificance,
      datasets: [
        {
          label: "Inhibition Rate (%)",
          data: chartData.inhibition_rates,
          backgroundColor: chartData.inhibition_rates.map(
            (value) =>
              value >= 0
                ? "rgba(37, 99, 235, 0.7)"
                : "rgba(180, 35, 24, 0.7)"
          ),
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
      },
      scales: {
        y: {
          title: {
            display: true,
            text: "Inhibition Rate (%)",
          },
        },
      },
    },
  });

  fluorescenceChartSection.hidden = false;
}

// ========================================
// Render fluorescence group results
// ========================================

function renderResults(results) {
  fluorescenceResultsBody.innerHTML = "";

  results.forEach((row) => {
    const tableRow = document.createElement("tr");

    const concentration =
      `${formatNumber(row.concentration)} ${
        row.concentration_unit || ""
      }`.trim();

    const pValueDisplay =
      row.p_value === null || row.p_value === undefined
        ? "-"
        : formatNumber(row.p_value);

    const values = [
      row.sample,
      row.aptamer,
      concentration,
      row.replicates,
      formatNumber(
        row.mean_normalized_gfp
      ),
      formatNumber(
        row.sd_normalized_gfp
      ),
      `${formatNumber(
        row.inhibition_rate
      )}%`,
      pValueDisplay,
      row.significance || "-",
    ];

    values.forEach((value, index) => {
      const cell = document.createElement("td");

      cell.textContent = value ?? "-";

      if (index === 6) {
        cell.className = "inhibition-cell";
      }

      if (index === 8 && row.significance && row.significance !== "ns" && row.significance !== "") {
        cell.className = "significance-cell";
      }

      tableRow.appendChild(cell);
    });

    fluorescenceResultsBody.appendChild(tableRow);
  });
}

// ========================================
// Number formatting
// ========================================

function formatNumber(value) {
  if (
    value === null
    || value === undefined
    || Number.isNaN(Number(value))
  ) {
    return "-";
  }

  return Number(value).toLocaleString(
    "en-US",
    {
      maximumFractionDigits: 4,
    }
  );
}

// ========================================
// Status message
// ========================================

function showStatus(
  element,
  message,
  type = ""
) {
  element.textContent = message;

  element.className =
    `status-message ${type}`.trim();
}

// ========================================
// Text & image analysis demo (original feature)
// ========================================

const form = document.getElementById("analyze-form");
const textInput = document.getElementById("text-input");
const imageInput = document.getElementById("image-input");
const imagePreview = document.getElementById(
  "image-preview"
);
const submitBtn = document.getElementById("submit-btn");
const resultSection = document.getElementById(
  "result-section"
);
const resultOutput = document.getElementById(
  "result-output"
);
const statusMessage = document.getElementById(
  "status-message"
);

let previewUrl = null;

// Image preview
imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];

  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }

  if (!file) {
    imagePreview.hidden = true;
    imagePreview.removeAttribute("src");
    return;
  }

  previewUrl = URL.createObjectURL(file);

  imagePreview.src = previewUrl;
  imagePreview.hidden = false;
});

// Submit text and image
form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = textInput.value.trim();
  const imageFile = imageInput.files[0];

  if (!text && !imageFile) {
    showStatus(
      statusMessage,
      "Please enter text or select an image.",
      "error"
    );
    return;
  }

  const formData = new FormData();

  formData.append("text", text);

  if (imageFile) {
    formData.append(
      "image",
      imageFile
    );
  }

  submitBtn.disabled = true;

  showStatus(
    statusMessage,
    "Sending, please wait..."
  );

  resultSection.hidden = true;

  try {
    const response = await fetch(
      `${BACKEND_URL}/api/analyze`,
      {
        method: "POST",
        body: formData,
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.detail
        || `HTTP ${response.status}`
      );
    }

    resultOutput.textContent = JSON.stringify(
      data,
      null,
      2
    );

    resultSection.hidden = false;

    showStatus(
      statusMessage,
      "Analysis complete.",
      "success"
    );
  } catch (error) {
    showStatus(
      statusMessage,
      `An error occurred: ${error.message}`,
      "error"
    );
  } finally {
    submitBtn.disabled = false;
  }
});

// ========================================
// Backend connectivity check
// ========================================

async function checkBackend() {
  try {
    const response = await fetch(
      `${BACKEND_URL}/health`
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    backendStatus.textContent = "Connected";
    backendStatus.className = "online";
  } catch (error) {
    backendStatus.textContent = "Connection failed";
    backendStatus.className = "offline";
  }
}

// ========================================
// ESP32 live sensor data
// ========================================

const sensorLatestValue = document.getElementById(
  "sensor-latest-value"
);
const sensorLatestName = document.getElementById(
  "sensor-latest-name"
);
const sensorLatestTime = document.getElementById(
  "sensor-latest-time"
);
const sensorLiveBadge = document.getElementById(
  "sensor-live-badge"
);

let sensorChartInstance = null;

async function loadSensorData() {
  try {
    const response = await fetch(
      `${BACKEND_URL}/esp32/data?limit=100`
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const readings = await response.json();

    updateSensorStats(readings);
    updateSensorChart(readings);

    sensorLiveBadge.textContent = "Live";
    sensorLiveBadge.classList.remove("status-badge-offline");
  } catch (error) {
    sensorLiveBadge.textContent = "Connection failed";
    sensorLiveBadge.classList.add("status-badge-offline");
  }
}

function updateSensorStats(readings) {
  if (!Array.isArray(readings) || readings.length === 0) {
    sensorLatestValue.textContent = "--";
    sensorLatestName.textContent = "--";
    sensorLatestTime.textContent = "--";
    return;
  }

  const latest = readings[readings.length - 1];

  const unitSuffix = latest.unit ? ` ${latest.unit}` : "";
  sensorLatestValue.textContent = `${formatNumber(latest.value)}${unitSuffix}`;
  sensorLatestName.textContent = latest.sensor || "--";
  sensorLatestTime.textContent = formatTimestamp(latest.timestamp);
}

function updateSensorChart(readings) {
  const canvas = document.getElementById("sensor-chart");

  const labels = readings.map((r) => formatTimestamp(r.timestamp, true));
  const values = readings.map((r) => r.value);

  if (!sensorChartInstance) {
    sensorChartInstance = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Sensor value",
            data: values,
            borderColor: "rgba(37, 99, 235, 0.9)",
            backgroundColor: "rgba(37, 99, 235, 0.12)",
            fill: true,
            tension: 0.25,
            pointRadius: 2,
          },
        ],
      },
      options: {
        responsive: true,
        animation: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 8 },
          },
          y: {
            title: {
              display: true,
              text: "Value",
            },
          },
        },
      },
    });
    return;
  }

  sensorChartInstance.data.labels = labels;
  sensorChartInstance.data.datasets[0].data = values;
  sensorChartInstance.update();
}

function formatTimestamp(isoString, shortForm = false) {
  if (!isoString) return "-";

  const date = new Date(isoString);

  if (Number.isNaN(date.getTime())) {
    return isoString;
  }

  if (shortForm) {
    return date.toLocaleTimeString("en-US", { hour12: false });
  }

  return date.toLocaleString("en-US", { hour12: false });
}

// ========================================
// ESP32 upload records
// ========================================

async function loadEsp32Records() {
  try {
    const response = await fetch(
      `${BACKEND_URL}/esp32/records`
    );

    if (!response.ok) {
      esp32RecordsContainer.innerHTML =
        '<p class="empty-message">'
        + "Unable to retrieve ESP32 records."
        + "</p>";

      return;
    }

    const records = await response.json();

    if (
      !Array.isArray(records)
      || records.length === 0
    ) {
      esp32RecordsContainer.innerHTML =
        '<p class="empty-message">'
        + "No ESP32 upload data yet."
        + "</p>";

      return;
    }

    esp32RecordsContainer.innerHTML = "";

    records.forEach((record) => {
      const card =
        document.createElement("article");

      card.className = "record-card";

      const time =
        document.createElement("p");

      time.className = "record-time";

      time.textContent =
        record.timestamp || "Unknown time";

      const text =
        document.createElement("p");

      text.textContent =
        record.text || "No text";

      card.append(
        time,
        text
      );

      if (record.image) {
        const image =
          document.createElement("img");

        image.src =
          `${BACKEND_URL}/esp32/uploads/${
            encodeURIComponent(record.image)
          }`;

        image.alt = "ESP32 uploaded photo";
        image.loading = "lazy";

        card.appendChild(image);
      }

      esp32RecordsContainer.appendChild(card);
    });
  } catch (error) {
    esp32RecordsContainer.innerHTML =
      '<p class="empty-message">'
      + "Connection failed, unable to retrieve ESP32 records."
      + "</p>";
  }
}

// ========================================
// Page init
// ========================================

checkBackend();
loadSensorData();
loadEsp32Records();

// Refresh live sensor data every 2 seconds
setInterval(loadSensorData, 2000);

// Refresh ESP32 upload records (images/text) every 5 seconds
setInterval(
  loadEsp32Records,
  5000
);
