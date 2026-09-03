// =========================================================
// 對接 index.html 裡「AS7341 Spectral Sensor」區塊：每 2 秒輪詢
// GET /api/hardware/latest，畫出 F1-F8 8 個可見光波段的長條圖；
// Clear/NIR 量級跟 F1-F8 差太多，不放進同一張圖，另外用兩個數值顯示。
// 目標元素：
//   #sensor-chart / #sensor-clear-value / #sensor-nir-value
//   #sensor-latest-time / #sensor-live-badge
// 依賴 js/config.js 的全域 BACKEND_BASE_URL，這支必須排在它後面載入。
// =========================================================

const SENSOR_POLL_INTERVAL_MS = 2000;
const SENSOR_STALE_MS = 10000; // 讀值超過這麼久沒更新就視為 offline（ESP32 斷線/沒在送）

// F1-F8 的中心波長與大致可見色，讓長條圖看起來像實際光譜分布
const SPECTRAL_CHANNELS = [
  { key: "f1", label: "F1\n415nm", color: "#7a00ff" },
  { key: "f2", label: "F2\n445nm", color: "#3a5bff" },
  { key: "f3", label: "F3\n480nm", color: "#00b3ff" },
  { key: "f4", label: "F4\n515nm", color: "#00c853" },
  { key: "f5", label: "F5\n555nm", color: "#a8d600" },
  { key: "f6", label: "F6\n590nm", color: "#ffb300" },
  { key: "f7", label: "F7\n630nm", color: "#ff5500" },
  { key: "f8", label: "F8\n680nm", color: "#e50000" },
];

let sensorChart = null;

function initSensorChart() {
  const canvas = document.getElementById("sensor-chart");
  if (!canvas) return;

  sensorChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: SPECTRAL_CHANNELS.map((c) => c.label),
      datasets: [
        {
          label: "ADC count",
          data: SPECTRAL_CHANNELS.map(() => 0),
          backgroundColor: SPECTRAL_CHANNELS.map((c) => c.color),
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: { ticks: { color: "#6b6055" }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#6b6055" }, grid: { color: "#e0d6c0" } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function setSensorLive(isLive) {
  const badge = document.getElementById("sensor-live-badge");
  if (!badge) return;
  badge.textContent = isLive ? "Live" : "Offline";
  badge.classList.toggle("offline", !isLive);
}

function updateSensorChart(channels) {
  if (!sensorChart) return;
  sensorChart.data.datasets[0].data = SPECTRAL_CHANNELS.map((c) => channels[c.key]);
  sensorChart.update();
}

async function pollSensorLatest() {
  try {
    const res = await fetch(`${BACKEND_BASE_URL}/api/hardware/latest`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reading = await res.json();

    if (reading.timestamp === null || !reading.channels) {
      setSensorLive(false);
      return;
    }

    updateSensorChart(reading.channels);
    document.getElementById("sensor-clear-value").textContent = reading.channels.clear;
    document.getElementById("sensor-nir-value").textContent = reading.channels.nir;
    document.getElementById("sensor-latest-time").textContent = new Date(reading.timestamp).toLocaleString();

    const ageMs = Date.now() - new Date(reading.timestamp).getTime();
    setSensorLive(ageMs < SENSOR_STALE_MS);
  } catch (err) {
    console.error("Failed to poll sensor data:", err);
    setSensorLive(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initSensorChart();
  pollSensorLatest();
  setInterval(pollSensorLatest, SENSOR_POLL_INTERVAL_MS);
});
