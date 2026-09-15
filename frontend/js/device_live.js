// =========================================================
// 對接 index.html 的 CAPTURE-Screen 卡片：即時監看（WebSocket /live）。
// 目標元素：
//   #device-card-description / #live-toggle / #live-toggle-reason
//   #live-dot / #live-dot-label / #live-rate
//   #live-chart-plate / #live-chart / #live-empty
// 依賴 js/config.js（DEVICE_MODE / DEVICE_BASE_URL）、js/hardware_processing.js、
// js/hardware_device.js，以及 Chart.js。
//
// 規則：
//   - Live 開關預設關閉，打開才建立 WebSocket 並送 live_start
//   - 即時資料（mode "live"）只畫在圖上，不寫進任何儲存、不進 plan、不擬合
//   - 關閉、離線、重連中都清空圖表，不顯示假資料或最後一筆快取
//   - 離開頁面時送 live_stop 並關閉連線（裝置斷線時也會自己回 IDLE、關 LED）
// =========================================================

const LIVE_MAX_RECONNECTS = 5;
const LIVE_RECONNECT_BASE_MS = 1000;
const LIVE_RATE_WINDOW = 10; // 用最近 10 筆的 seq 與 t_ms 算更新率

// 首頁不載入 hardware_common.js，軸標籤在這裡自己定義一份。
const LIVE_CHANNELS = [
  { key: "F1", label: "415" },
  { key: "F2", label: "445" },
  { key: "F3", label: "480" },
  { key: "F4", label: "515" },
  { key: "F5", label: "555" },
  { key: "F6", label: "590" },
  { key: "F7", label: "630" },
  { key: "F8", label: "680" },
  { key: "CLR", label: "Clr" },
  { key: "NIR", label: "NIR" },
];

let liveSocket = null;
let liveWanted = false;       // 使用者開著 Live
let liveStreaming = false;    // 裝置已確認進入 LIVE（收到 state LIVE 或第一筆資料）
let liveReconnects = 0;
let liveReconnectTimer = null;
let liveChart = null;
let liveBuildId = null;
const liveSamples = [];

function liveCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function liveEl(id) {
  return document.getElementById(id);
}

// state: "streaming" 綠 / "reconnecting" 黃 / "off" 灰
function setLiveDot(state, label) {
  liveEl("live-dot").className = `live-dot is-${state}`;
  liveEl("live-dot-label").textContent = label;
}

function setLiveDescription(text) {
  liveEl("device-card-description").textContent = text;
}

function clearLiveView(message) {
  if (liveChart) {
    liveChart.destroy();
    liveChart = null;
  }
  liveSamples.length = 0;
  liveEl("live-chart-plate").hidden = true;
  const empty = liveEl("live-empty");
  empty.textContent = message;
  empty.hidden = false;
  liveEl("live-rate").textContent = "-- Hz";
}

function ensureLiveChart() {
  if (liveChart) return liveChart;
  const accent = liveCssVar("--accent");
  const gold = liveCssVar("--gold");
  const muted = liveCssVar("--muted");
  const rule = liveCssVar("--border");

  liveChart = new Chart(liveEl("live-chart"), {
    type: "bar",
    data: {
      labels: LIVE_CHANNELS.map((ch) => ch.label),
      datasets: [{
        label: "Raw counts",
        data: LIVE_CHANNELS.map(() => 0),
        backgroundColor: LIVE_CHANNELS.map(({ key }) => (key === "F4" ? accent : key === "F3" ? gold : muted)),
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      aspectRatio: 2.4,
      animation: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: muted, font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: rule }, ticks: { color: muted, font: { size: 10 }, maxTicksLimit: 4 } },
      },
      plugins: { legend: { display: false } },
    },
  });
  return liveChart;
}

function renderLiveFrame(message) {
  const raw = message.raw;
  const valid = raw && LIVE_CHANNELS.every(({ key }) => Number.isFinite(raw[key]))
    && Number.isFinite(message.seq) && Number.isFinite(message.t_ms);
  if (!valid) {
    console.error("Unexpected response from device (live frame):", message);
    return;
  }

  if (!liveStreaming) {
    liveStreaming = true;
    refreshLiveDescription();
  }
  liveReconnects = 0;
  setLiveDot("streaming", "Streaming");

  const chart = ensureLiveChart();
  chart.data.datasets[0].data = LIVE_CHANNELS.map(({ key }) => raw[key]);
  chart.update();
  liveEl("live-empty").hidden = true;
  liveEl("live-chart-plate").hidden = false;

  // 更新率 = seq 差 / 裝置時間差：用裝置自己的 t_ms，網路抖動不影響，掉包也不會算少。
  liveSamples.push({ seq: message.seq, t: message.t_ms });
  if (liveSamples.length > LIVE_RATE_WINDOW) liveSamples.shift();
  const first = liveSamples[0];
  const last = liveSamples[liveSamples.length - 1];
  if (liveSamples.length >= 2 && last.t > first.t && last.seq > first.seq) {
    liveEl("live-rate").textContent = `${(((last.seq - first.seq) * 1000) / (last.t - first.t)).toFixed(1)} Hz`;
  }
}

async function refreshLiveDescription() {
  try {
    const status = await HardwareDevice.status();
    liveBuildId = status.build_id;
    setLiveDescription(`Connected · ${liveBuildId}`);
  } catch (err) {
    if (!liveStreaming) setLiveDescription("Device offline");
  }
}

function openLiveSocket() {
  let socket;
  try {
    socket = new WebSocket(HardwareDevice.liveUrl());
  } catch (err) {
    scheduleLiveReconnect();
    return;
  }
  liveSocket = socket;

  socket.onopen = () => {
    if (socket !== liveSocket) return;
    socket.send(JSON.stringify({ cmd: "live_start" }));
  };

  socket.onmessage = (event) => {
    if (socket !== liveSocket || !liveWanted) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      console.error("Unexpected response from device (live):", event.data);
      return;
    }

    if (message.mode === "live") {
      renderLiveFrame(message);
    } else if (message.mode === "state") {
      if (message.state === "LIVE") {
        liveStreaming = true;
      } else if (liveStreaming) {
        // 串流中裝置轉離 LIVE：通常是有人送了 POST /read。裝置不會自動恢復 LIVE。
        stopLive("Live stream stopped by the device (a measurement started).");
      }
    } else if (message.error === "busy") {
      stopLive("Device is busy, try again");
    }
  };

  socket.onclose = () => {
    if (socket !== liveSocket) return;
    liveSocket = null;
    if (liveWanted) scheduleLiveReconnect();
  };
}

function scheduleLiveReconnect() {
  liveStreaming = false;
  clearLiveView("Connection lost. Reconnecting...");

  if (liveReconnects >= LIVE_MAX_RECONNECTS) {
    liveWanted = false;
    liveEl("live-toggle").checked = false;
    setLiveDot("off", "Offline");
    setLiveDescription("Device offline");
    clearLiveView(`Device not reachable at ${DEVICE_BASE_URL}`);
    return;
  }

  liveReconnects += 1;
  setLiveDot("reconnecting", `Reconnecting (${liveReconnects}/${LIVE_MAX_RECONNECTS})`);
  liveReconnectTimer = setTimeout(openLiveSocket, LIVE_RECONNECT_BASE_MS * liveReconnects);
}

function startLive() {
  liveWanted = true;
  liveStreaming = false;
  liveReconnects = 0;
  setLiveDot("reconnecting", "Connecting...");
  clearLiveView("Waiting for data...");
  openLiveSocket();
}

function stopLive(message) {
  liveWanted = false;
  liveStreaming = false;
  clearTimeout(liveReconnectTimer);
  const socket = liveSocket;
  liveSocket = null;
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ cmd: "live_stop" }));
    socket.close();
  }
  liveEl("live-toggle").checked = false;
  setLiveDot("off", "Off");
  clearLiveView(message || "Live view is off.");
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = liveEl("live-toggle");
  const reason = liveEl("live-toggle-reason");

  setLiveDot("off", "Off");
  clearLiveView("Live view is off.");

  if (DEVICE_MODE !== "live") {
    setLiveDescription("Runs on simulated data");
    toggle.disabled = true;
    reason.textContent = window.location.protocol === "https:"
      ? "Live view needs the frontend served over http on the device's network (HTTPS pages can't reach it)."
      : "Live view needs DEVICE_MODE_SETTING = \"live\" in js/config.js.";
    reason.hidden = false;
    return;
  }

  setLiveDescription(`Checking ${DEVICE_BASE_URL}...`);
  refreshLiveDescription();

  toggle.addEventListener("change", () => {
    if (toggle.checked) startLive();
    else stopLive();
  });

  // 離開首頁（包括點進 /hardware 任一子頁）時停止串流。
  window.addEventListener("pagehide", () => {
    if (liveWanted) stopLive();
  });
});
