// =========================================================
// 對接 hardware.html 的即時資料區塊：每 2 秒輪詢
// GET /api/hardware_gy302/latest，畫出最近的 lux 折線圖。
// 後端只存「最新一筆」沒有歷史紀錄，所以歷史點是前端自己在記憶體裡
// 累積的 rolling window（重新整理頁面就會清空，這是可接受的取捨）。
// 目標元素：
//   #gy302-chart / #gy302-lux-value / #gy302-latest-time / #gy302-live-badge
// 依賴 js/config.js 的全域 BACKEND_BASE_URL，這支必須排在它後面載入。
// =========================================================

const GY302_POLL_INTERVAL_MS = 2000;
const GY302_STALE_MS = 10000; // 讀值超過這麼久沒更新就視為 offline（ESP32 斷線/沒在送）
const GY302_HISTORY_LENGTH = 30; // 折線圖最多保留幾個點

let gy302Chart = null;
let gy302LastTimestamp = null; // 用來避免同一筆讀值重複畫進折線圖

function initGy302Chart() {
  const canvas = document.getElementById("gy302-chart");
  if (!canvas) return;

  gy302Chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Lux",
          data: [],
          borderColor: "#ffb300",
          backgroundColor: "rgba(255, 179, 0, 0.15)",
          fill: true,
          tension: 0.25,
          pointRadius: 2,
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

function setGy302Live(isLive) {
  const badge = document.getElementById("gy302-live-badge");
  if (!badge) return;
  badge.textContent = isLive ? "Live" : "Offline";
  badge.classList.toggle("offline", !isLive);
}

function pushGy302Reading(lux, timestamp) {
  if (!gy302Chart) return;
  gy302Chart.data.labels.push(new Date(timestamp).toLocaleTimeString());
  gy302Chart.data.datasets[0].data.push(lux);

  if (gy302Chart.data.labels.length > GY302_HISTORY_LENGTH) {
    gy302Chart.data.labels.shift();
    gy302Chart.data.datasets[0].data.shift();
  }

  gy302Chart.update();
}

async function pollGy302Latest() {
  try {
    const res = await fetch(`${BACKEND_BASE_URL}/api/hardware_gy302/latest`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reading = await res.json();

    if (reading.timestamp === null || reading.lux === null) {
      setGy302Live(false);
      return;
    }

    document.getElementById("gy302-lux-value").textContent = reading.lux.toFixed(1);
    document.getElementById("gy302-latest-time").textContent = new Date(reading.timestamp).toLocaleString();

    if (reading.timestamp !== gy302LastTimestamp) {
      gy302LastTimestamp = reading.timestamp;
      pushGy302Reading(reading.lux, reading.timestamp);
    }

    const ageMs = Date.now() - new Date(reading.timestamp).getTime();
    setGy302Live(ageMs < GY302_STALE_MS);
  } catch (err) {
    console.error("Failed to poll GY-302 data:", err);
    setGy302Live(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initGy302Chart();
  pollGy302Latest();
  setInterval(pollGy302Latest, GY302_POLL_INTERVAL_MS);
});
