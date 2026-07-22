const BACKEND_URL = "https://igem-ncku-software.onrender.com";

// ========================================
// 共用 DOM
// ========================================

const backendStatus = document.getElementById("backend-status");
const esp32RecordsContainer = document.getElementById("esp32-records");

// ========================================
// Fluorescence CSV 分析
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
const fluorescenceResults = document.getElementById(
  "fluorescence-results"
);
const fluorescenceResultsBody = document.getElementById(
  "fluorescence-results-body"
);

fluorescenceForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = fluorescenceFileInput.files[0];

  if (!file) {
    showStatus(
      fluorescenceStatus,
      "請先選擇一個 CSV 檔案。",
      "error"
    );
    return;
  }

  if (!file.name.toLowerCase().endsWith(".csv")) {
    showStatus(
      fluorescenceStatus,
      "目前只支援 CSV 檔案。",
      "error"
    );
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  fluorescenceSubmit.disabled = true;

  showStatus(
    fluorescenceStatus,
    "分析中，請稍候..."
  );

  fluorescenceSummary.hidden = true;
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
    renderResults(data.results);

    fluorescenceSummary.hidden = false;
    fluorescenceResults.hidden = false;

    showStatus(
      fluorescenceStatus,
      "分析完成。",
      "success"
    );
  } catch (error) {
    showStatus(
      fluorescenceStatus,
      `分析失敗：${error.message}`,
      "error"
    );
  } finally {
    fluorescenceSubmit.disabled = false;
  }
});

// ========================================
// 顯示 Fluorescence 摘要
// ========================================

function renderSummary(summary) {
  const items = [
    [
      "檔案名稱",
      summary.original_file_name
        || summary.file_name
        || "-"
    ],
    [
      "資料筆數",
      summary.total_rows ?? "-"
    ],
    [
      "分組數量",
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
// 顯示 Fluorescence 分組結果
// ========================================

function renderResults(results) {
  fluorescenceResultsBody.innerHTML = "";

  results.forEach((row) => {
    const tableRow = document.createElement("tr");

    const concentration =
      `${formatNumber(row.concentration)} ${
        row.concentration_unit || ""
      }`.trim();

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
    ];

    values.forEach((value, index) => {
      const cell = document.createElement("td");

      cell.textContent = value ?? "-";

      if (index === 6) {
        cell.className = "inhibition-cell";
      }

      tableRow.appendChild(cell);
    });

    fluorescenceResultsBody.appendChild(tableRow);
  });
}

// ========================================
// 數字格式
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
    "zh-TW",
    {
      maximumFractionDigits: 2,
    }
  );
}

// ========================================
// 狀態訊息
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
// 原本的文字與圖片分析功能
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

// 圖片預覽
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

// 傳送文字與圖片
form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = textInput.value.trim();
  const imageFile = imageInput.files[0];

  if (!text && !imageFile) {
    showStatus(
      statusMessage,
      "請至少輸入文字或選擇一張圖片。",
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
    "傳送中，請稍候..."
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
      "分析完成。",
      "success"
    );
  } catch (error) {
    showStatus(
      statusMessage,
      `發生錯誤：${error.message}`,
      "error"
    );
  } finally {
    submitBtn.disabled = false;
  }
});

// ========================================
// 後端連線檢查
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

    backendStatus.textContent = "已連線";
    backendStatus.className = "online";
  } catch (error) {
    backendStatus.textContent = "連線失敗";
    backendStatus.className = "offline";
  }
}

// ========================================
// ESP32 上傳紀錄
// ========================================

async function loadEsp32Records() {
  try {
    const response = await fetch(
      `${BACKEND_URL}/esp32/records`
    );

    if (!response.ok) {
      esp32RecordsContainer.innerHTML =
        '<p class="empty-message">'
        + "無法取得 ESP32 紀錄。"
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
        + "目前尚無 ESP32 上傳資料。"
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

        image.alt = "ESP32 上傳照片";
        image.loading = "lazy";

        card.appendChild(image);
      }

      esp32RecordsContainer.appendChild(card);
    });
  } catch (error) {
    esp32RecordsContainer.innerHTML =
      '<p class="empty-message">'
      + "連線失敗，無法取得 ESP32 紀錄。"
      + "</p>";
  }
}

// ========================================
// 頁面初始化
// ========================================

checkBackend();
loadEsp32Records();

// 每 5 秒重新取得 ESP32 紀錄
setInterval(
  loadEsp32Records,
  5000
);