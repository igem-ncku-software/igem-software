// =========================================================
// 首頁的 CAPTURE-Screen 即時光譜。
// 目標元素：
//   #live-toggle / #live-dot / #live-dot-label / #live-device
//   #live-f4 / #live-f3 / #live-rate / #live-saturation / #live-full-scale
//   #live-empty / #live-spectrum / #live-chart
// 依賴 js/config.js（BACKEND_BASE_URL）與 Chart.js。
//
// 頁面一打開就連 WS /api/hardware/live，隨時知道裝置在不在線；打開 Live 開關
// 才送 live_start。後端統計所有開著 Live 的瀏覽器，裝置的 LED 只在有人在看時
// 亮（一直亮會加熱、漂白樣品），所以開關預設關閉。
//
// 規則：
//   - 即時資料只畫圖，不寫進任何儲存、不進 plan、不擬合
//   - 裝置離線或連線中斷就清空圖表，不把最後一筆留著當成現在的數值
//   - 斷線自動重連（睡著的 Render 後端要幾十秒才醒），不用重新整理頁面
// =========================================================

const LIVE_URL = `${BACKEND_BASE_URL.replace(/^http/, "ws")}/api/hardware/live`;
const LIVE_RECONNECT_MIN_MS = 1000;
const LIVE_RECONNECT_MAX_MS = 15000;
const LIVE_RATE_WINDOW = 10; // 用最近 10 幀的 seq 與 t_ms 算更新率
// 裝置每 5 秒回報一次；這麼久完全沒消息就不再相信它在線（後端可能還沒發現連線斷了）。
const LIVE_PRESENCE_STALE_MS = 20000;
const LIVE_PRESENCE_CHECK_MS = 5000;
const LIVE_ADC_MAX_COUNTS = 65535;

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
let liveReconnectMs = LIVE_RECONNECT_MIN_MS;
let liveReconnectTimer = null;
let liveWanted = false;     // 使用者開著 Live
let liveOnline = false;     // 後端最近一次說裝置在線
let liveDevice = null;      // 裝置最近一次回報的 status
let liveLastSeen = null;
let liveLastPresenceMs = 0;
let liveStreaming = false;  // 開著 Live 之後已經收到至少一幀
let liveChart = null;
const liveSamples = [];     // {seq, t}

function liveEl(id) {
  return document.getElementById(id);
}

function liveCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function liveAgo(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

// ADC 在 min(65535, (ATIME+1)(ASTEP+1)) 飽和，跟 hardware_processing.js 同一條規則。
function liveFullScale(config) {
  return Math.min(LIVE_ADC_MAX_COUNTS, (config.atime + 1) * (config.astep + 1));
}

// ---- 狀態文字 --------------------------------------------------------

function renderLiveState() {
  const connected = liveSocket?.readyState === WebSocket.OPEN;

  let dot = "off";
  let label = "Off";
  if (!connected) {
    dot = "reconnecting";
    label = "Connecting...";
  } else if (!liveOnline) {
    label = "Device offline";
  } else if (liveWanted && liveDevice?.state === "MEASURING") {
    dot = "reconnecting";
    label = "Paused: measuring";
  } else if (liveWanted) {
    dot = liveStreaming ? "streaming" : "reconnecting";
    label = liveStreaming ? "Streaming" : "Starting...";
  }
  liveEl("live-dot").className = `live-dot is-${dot}`;
  liveEl("live-dot-label").textContent = label;

  const description = liveEl("live-device");
  if (!connected) {
    description.textContent = "Connecting to the backend. A sleeping backend can take up to a minute to wake.";
  } else if (liveOnline && liveDevice) {
    description.textContent =
      `CAPTURE-Screen online · ${liveDevice.build_id} · firmware ${liveDevice.firmware_version} · Wi-Fi ${liveDevice.wifi_rssi} dBm`;
  } else if (liveDevice && liveLastSeen) {
    description.textContent = `CAPTURE-Screen offline · last seen ${liveAgo(liveLastSeen)}`;
  } else {
    description.textContent = "CAPTURE-Screen has not connected yet. Power it on where it can reach its Wi-Fi.";
  }
}

function liveIdleMessage() {
  if (!liveOnline) return "CAPTURE-Screen is offline. The spectrum appears here once it connects.";
  if (liveWanted) return "Waiting for the first frame...";
  return "Turn on Live to stream the spectrum. The reader's LED is on only while someone is watching.";
}

function clearLiveData(message) {
  liveStreaming = false;
  liveSamples.length = 0;
  liveChart?.destroy();
  liveChart = null;

  liveEl("live-spectrum").hidden = true;
  liveEl("live-saturation").hidden = true;
  for (const id of ["live-f4", "live-f3", "live-rate"]) liveEl(id).textContent = "--";
  const empty = liveEl("live-empty");
  empty.textContent = message;
  empty.hidden = false;
}

// ---- 圖表 ------------------------------------------------------------

function ensureLiveChart() {
  if (liveChart) return;
  const accent = liveCssVar("--accent");
  const gold = liveCssVar("--gold");
  const muted = liveCssVar("--muted");
  const ink = liveCssVar("--text");
  const rule = liveCssVar("--border");
  const ticks = { color: muted, font: { size: 10 } };

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
        x: { title: { display: true, text: "Channel (nm)", color: ink }, grid: { display: false }, ticks },
        y: {
          beginAtZero: true,
          title: { display: true, text: "Raw counts", color: ink },
          grid: { color: rule },
          ticks: { ...ticks, maxTicksLimit: 5 },
        },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderSaturation(raw) {
  const el = liveEl("live-saturation");
  if (!liveDevice) {
    el.hidden = true;
    return;
  }
  const limit = liveFullScale(liveDevice.config);
  const saturated = LIVE_CHANNELS.filter(({ key }) => raw[key] >= limit).map((ch) => ch.label);
  el.hidden = saturated.length === 0;
  el.textContent = `Saturated at ${limit} counts: ${saturated.join(", ")}. These channels show the ADC ceiling, not the sample.`;
}

// ---- 訊息 ------------------------------------------------------------

function onLivePresence(message) {
  liveOnline = message.online === true;
  if (message.device) liveDevice = message.device;
  if (message.last_seen) liveLastSeen = message.last_seen;
  liveLastPresenceMs = Date.now();

  if (liveDevice) liveEl("live-full-scale").textContent = String(liveFullScale(liveDevice.config));
  if (!liveOnline || !liveStreaming) clearLiveData(liveIdleMessage());
  renderLiveState();
}

function onLiveFrame(message) {
  const { raw } = message;
  const valid = raw && LIVE_CHANNELS.every(({ key }) => Number.isFinite(raw[key]))
    && Number.isFinite(message.seq) && Number.isFinite(message.t_ms);
  if (!valid) {
    console.error("Unexpected live frame:", message);
    return;
  }
  if (!liveWanted) return;

  ensureLiveChart();
  liveStreaming = true;
  liveEl("live-empty").hidden = true;
  liveEl("live-spectrum").hidden = false;
  liveEl("live-f4").textContent = String(raw.F4);
  liveEl("live-f3").textContent = String(raw.F3);

  liveChart.data.datasets[0].data = LIVE_CHANNELS.map(({ key }) => raw[key]);
  liveChart.update();

  // 更新率 = seq 差 / 裝置時間差：用裝置自己的時鐘，網路抖動不影響。
  // 裝置重開機後 t_ms 從 0 重新算，舊樣本要丟掉。
  const newest = liveSamples[liveSamples.length - 1];
  if (newest && message.t_ms <= newest.t) liveSamples.length = 0;
  liveSamples.push({ seq: message.seq, t: message.t_ms });
  if (liveSamples.length > LIVE_RATE_WINDOW) liveSamples.shift();
  const first = liveSamples[0];
  const last = liveSamples[liveSamples.length - 1];
  if (last.t > first.t && last.seq > first.seq) {
    liveEl("live-rate").textContent = (((last.seq - first.seq) * 1000) / (last.t - first.t)).toFixed(1);
  }

  renderSaturation(raw);
  renderLiveState();
}

// ---- 連線 ------------------------------------------------------------

function openLiveSocket() {
  clearTimeout(liveReconnectTimer);
  const socket = new WebSocket(LIVE_URL);
  liveSocket = socket;
  renderLiveState();

  socket.onopen = () => {
    if (socket !== liveSocket) return;
    liveReconnectMs = LIVE_RECONNECT_MIN_MS;
    if (liveWanted) socket.send(JSON.stringify({ cmd: "live_start" }));
    renderLiveState();
  };

  socket.onmessage = (event) => {
    if (socket !== liveSocket) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      console.error("Unexpected message from the live backend:", event.data);
      return;
    }
    if (message.mode === "presence") onLivePresence(message);
    else if (message.mode === "live") onLiveFrame(message);
    else if (message.mode === "error") console.error("The live backend rejected a command:", message);
  };

  socket.onclose = () => {
    if (socket !== liveSocket) return;
    liveSocket = null;
    liveOnline = false;
    clearLiveData(`Lost the connection to the backend. Retrying in ${Math.round(liveReconnectMs / 1000)} s...`);
    liveReconnectTimer = setTimeout(openLiveSocket, liveReconnectMs);
    liveReconnectMs = Math.min(liveReconnectMs * 2, LIVE_RECONNECT_MAX_MS);
    renderLiveState();
  };
}

function setLiveWanted(wanted) {
  liveWanted = wanted;
  if (liveSocket?.readyState === WebSocket.OPEN) {
    liveSocket.send(JSON.stringify({ cmd: wanted ? "live_start" : "live_stop" }));
  }
  clearLiveData(liveIdleMessage());
  renderLiveState();
}

function checkLivePresence() {
  if (liveOnline && Date.now() - liveLastPresenceMs > LIVE_PRESENCE_STALE_MS) {
    liveOnline = false;
    clearLiveData(liveIdleMessage());
  }
  renderLiveState(); // 也順便更新「last seen … ago」
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = liveEl("live-toggle");
  toggle.addEventListener("change", () => setLiveWanted(toggle.checked));

  clearLiveData(liveIdleMessage());
  openLiveSocket();
  setInterval(checkLivePresence, LIVE_PRESENCE_CHECK_MS);

  // 離開頁面就關掉連線：後端少算一個觀看者，沒人看時會自己叫裝置關 LED。
  window.addEventListener("pagehide", () => {
    clearTimeout(liveReconnectTimer);
    const socket = liveSocket;
    liveSocket = null;
    socket?.close();
  });
  // 從上一頁／下一頁快取回來時頁面狀態還在，只要重新連線。
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !liveSocket) openLiveSocket();
  });
});
