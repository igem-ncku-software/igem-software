// =========================================================
// 對接 index.html 裡「ESP32 Live Sensor Data」區塊
// 目標元素：
//   #sensor-latest-value / #sensor-latest-name / #sensor-latest-time
//   #sensor-chart（canvas，畫折線圖）
//   #sensor-live-badge（狀態徽章）
//   #backend-status（頁尾後端狀態）
// =========================================================

const HARDWARE_API_URL = "https://igem-ncku-software.onrender.com/api/hardware/latest";
const POLL_INTERVAL_MS = 2000;
const MAX_CHART_POINTS = 30; // 圖表上最多保留幾個點（目前資料是前端自己累積的，重新整理頁面會重置）

let sensorChart = null;
const chartLabels = [];
const chartValues = [];

function initChart() {
  const canvas = document.getElementById("sensor-chart");
  if (!canvas || typeof Chart === "undefined") return;

  sensorChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [
        {
          label: "Sensor value",
          data: chartValues,
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 2,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: { display: true, ticks: { maxTicksLimit: 6 } },
        y: { display: true, beginAtZero: false },
      },
      plugins: {
        legend: { display: false },
      },
    },
  });
}

function pushChartPoint(value, timeLabel) {
  if (!sensorChart) return;

  chartLabels.push(timeLabel);
  chartValues.push(value);

  if (chartLabels.length > MAX_CHART_POINTS) {
    chartLabels.shift();
    chartValues.shift();
  }

  sensorChart.update();
}

function setBackendStatus(text, ok) {
  const el = document.getElementById("backend-status");
  if (el) el.textContent = text;

  const badge = document.getElementById("sensor-live-badge");
  if (badge) {
    badge.textContent = ok ? "Live" : "Offline";
    badge.style.opacity = ok ? "1" : "0.5";
  }
}

async function fetchLatestSensorData() {
  try {
    const res = await fetch(HARDWARE_API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (data.value === null || data.value === undefined) {
      setBackendStatus("已連線，尚未收到 ESP32 資料", true);
      return;
    }

    document.getElementById("sensor-latest-value").textContent = data.value.toFixed(2);
    document.getElementById("sensor-latest-name").textContent = data.device_id || "--";
    document.getElementById("sensor-latest-time").textContent = data.received_at || "--";

    const timeLabel = data.received_at ? data.received_at.split("T")[1].split(".")[0] : "";
    pushChartPoint(data.value, timeLabel);

    setBackendStatus("Connected", true);
  } catch (err) {
    console.error("抓取 ESP32 資料失敗：", err);
    setBackendStatus("連線失敗，重試中...", false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initChart();
  fetchLatestSensorData();
  setInterval(fetchLatestSensorData, POLL_INTERVAL_MS);
});
