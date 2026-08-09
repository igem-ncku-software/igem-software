// =========================================================
// 加到 frontend/js/hardware.js
// 假設 hardware.html 裡有一個元素顯示數值，例如：
//   <p>目前數值：<span id="sensor-value">--</span> <span id="sensor-unit"></span></p>
//   <p>裝置：<span id="sensor-device">--</span>｜更新時間：<span id="sensor-time">--</span></p>
// =========================================================

const BACKEND_URL = "https://igem-ncku-software.onrender.com/api/hardware/latest";

const POLL_INTERVAL_MS = 2000; // 每 2 秒問一次後端

async function fetchLatestData() {
  try {
    const res = await fetch(BACKEND_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    updateUI(data);
  } catch (err) {
    console.error("抓取硬體資料失敗：", err);
    setStatus("連線失敗，重試中...");
  }
}

function updateUI(data) {
  if (data.value === null || data.value === undefined) {
    setStatus("尚未收到 ESP32 的資料");
    return;
  }

  document.getElementById("sensor-value").textContent = data.value.toFixed(2);
  document.getElementById("sensor-unit").textContent = data.unit || "";
  document.getElementById("sensor-device").textContent = data.device_id || "--";
  document.getElementById("sensor-time").textContent = data.received_at || "--";
  setStatus("");
}

function setStatus(msg) {
  const statusEl = document.getElementById("sensor-status");
  if (statusEl) statusEl.textContent = msg;
}

// 頁面載入後開始輪詢
fetchLatestData();
setInterval(fetchLatestData, POLL_INTERVAL_MS);
