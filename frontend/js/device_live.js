// =========================================================
// 首頁的 CAPTURE-Screen 即時光譜。
// 目標元素：
//   #live-toggle / #live-dot / #live-dot-label
//   #live-f4
//   #live-empty / #live-spectrum / #live-chart / #live-settings
// 依賴 js/config.js（BACKEND_BASE_URL）與 Chart.js。
//
// 頁面一打開就連 WS /api/live/spectrum，隨時知道裝置在不在線；Live 開關打開、
// 而且分頁在前景時才送 live_start。後端統計所有在看的瀏覽器，裝置的 LED 只在
// 有人在看時亮（一直亮會加熱、漂白樣品），所以開關預設關閉，分頁切到背景也
// 先叫它關掉，回來再開。
//
// 每一項資訊只放在一個地方：
//   圓點旁的一個詞     現在的狀態（liveStatus()）
//   圖表位置的框       細節與下一步（liveStatus()）
//   圖表下的設定列     哪一台、韌體、Wi-Fi（離線時是最後回報的那台，不含 Wi-Fi），
//                      以及 gain、積分時間、LED 電流、滿格值——少了它們原始計數無從解讀
//
// 規則：
//   - 即時資料只畫圖，不寫進任何儲存、不進 plan、不擬合
//   - 只特別標出 sfGFP 通道 F4，不顯示漏光（F3）與更新率
//   - 裝置離線或連線中斷就清空圖表，不把最後一筆留著當成現在的數值
//   - 斷線自動重連（睡著的 Render 後端要幾十秒才醒），不用重新整理頁面
// =========================================================

const LIVE_URL = `${BACKEND_BASE_URL.replace(/^http/, "ws")}/api/live/spectrum`;
const LIVE_RECONNECT_MIN_MS = 1000;
const LIVE_RECONNECT_MAX_MS = 15000;
// 裝置沉默時後端會自己推離線；但裝置在線時每 5 秒就有一則 presence，這麼久沒收到代表瀏覽器到後端的連線默默斷了。
const LIVE_PRESENCE_STALE_MS = 20000;
// 每秒一次：重連倒數與「last seen … ago」要跟著走。
const LIVE_TICK_MS = 1000;
// 積分時間與滿格值跟 hardware_processing.js 同一套公式：(ATIME+1)(ASTEP+1) 步，每步 2.78 µs，
// ADC 在 min(65535, (ATIME+1)(ASTEP+1)) 飽和。
const LIVE_ADC_MAX_COUNTS = 65535;
const LIVE_ASTEP_UNIT_MS = 2.78e-3;
// 圖表比這窄（手機）時，2.4 的長寬比只剩一百多 px 高、十個軸標籤也擠不下：改成接近方形，標籤只留通道代號。
const LIVE_NARROW_CHART_PX = 480;

// 首頁不載入 hardware_common.js，通道名稱在這裡自己定義一份。
const LIVE_CHANNELS = [
  { key: "F1", nm: 415 },
  { key: "F2", nm: 445 },
  { key: "F3", nm: 480 },
  { key: "F4", nm: 515 },
  { key: "F5", nm: 555 },
  { key: "F6", nm: 590 },
  { key: "F7", nm: 630 },
  { key: "F8", nm: 680 },
  { key: "CLR", name: "Clear", short: "Clr" },
  { key: "NIR", name: "NIR", short: "NIR" },
];

let liveSocket = null;
let liveReconnectMs = LIVE_RECONNECT_MIN_MS;
let liveReconnectTimer = null;
let liveRetryAt = 0;        // 下一次重連的時間；0 表示沒有在等
let liveWanted = false;     // 使用者開著 Live
let liveOnline = false;     // 後端最近一次說裝置在線
let liveDevice = null;      // 裝置最近一次回報的 status
let liveLastSeen = null;
let liveLastPresenceMs = 0;
let liveStreaming = false;  // 開著 Live 之後已經收到至少一幀，圖表正顯示著
let liveChart = null;

// ---- 小工具 ----------------------------------------------------------

function liveEl(id) {
  return document.getElementById(id);
}

// 內容沒變就不重設：#live-dot-label 在 aria-live 區塊裡，每秒重設會讓螢幕閱讀器一直重唸。
function setLiveText(id, text) {
  const el = liveEl(id);
  if (el.textContent !== text) el.textContent = text;
}

function liveCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function liveCounts(value) {
  return value.toLocaleString("en-US");
}

function liveAgo(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

// ["F4", "515 nm"]：圖表軸上分兩行；文字裡接成一行。
function liveChannelLines({ key, nm, name }) {
  return nm ? [key, `${nm} nm`] : [name];
}

function liveChannelName(channel) {
  return liveChannelLines(channel).join(" ");
}

function liveFullScale(config) {
  return Math.min(LIVE_ADC_MAX_COUNTS, (config.atime + 1) * (config.astep + 1));
}

function liveIntegrationMs(config) {
  return (config.atime + 1) * (config.astep + 1) * LIVE_ASTEP_UNIT_MS;
}

// 開著 Live 但分頁在背景，沒有人看得到，LED 不該為它亮著。
function liveWatching() {
  return liveWanted && !document.hidden;
}

// ---- 狀態 ------------------------------------------------------------

function liveStatus() {
  if (liveSocket?.readyState !== WebSocket.OPEN) {
    const retryS = Math.ceil((liveRetryAt - Date.now()) / 1000);
    return {
      dot: "reconnecting",
      label: "Connecting",
      // 睡著的 Render 後端要將近一分鐘才醒，不說一聲看起來像壞了。
      message: liveRetryAt && retryS > 0
        ? `Connection lost. Retrying in ${retryS} s`
        : "Connecting to backend (up to 1 min after idle)...",
    };
  }
  if (!liveOnline) {
    return {
      dot: "off",
      label: "Offline",
      message: liveDevice && liveLastSeen ? `Last seen ${liveAgo(liveLastSeen)}` : "Waiting for CAPTURE-Screen to connect",
    };
  }
  const measuring = liveDevice?.state === "MEASURING";
  if (!liveWanted) {
    return { dot: "off", label: measuring ? "Measuring" : "Online", message: "Turn on Live to switch on the LED and stream" };
  }
  if (measuring) {
    return { dot: "reconnecting", label: "Measuring", message: "Stream starts after the measurement" };
  }
  if (!liveStreaming) {
    return { dot: "reconnecting", label: "Starting", message: "Waiting for first frame..." };
  }
  return { dot: "streaming", label: "Streaming", message: "" };
}

function renderSettings() {
  const el = liveEl("live-settings");
  el.hidden = !liveDevice;
  if (!liveDevice) return;

  const { config } = liveDevice;
  const items = [
    ["Build", liveDevice.build_id],
    ["Firmware", liveDevice.firmware_version],
    // 離線時 Wi-Fi 強度已經是舊的，不列出來。
    ...(liveOnline ? [["Wi-Fi", `${liveDevice.wifi_rssi} dBm`]] : []),
    ["Gain", `${config.gain}×`],
    ["Integration", `${liveIntegrationMs(config).toFixed(2)} ms`],
    ["LED", `${config.led_current_mA} mA`],
    ["Full scale", `${liveCounts(liveFullScale(config))} counts`],
  ];
  const text = items.map(([label, value]) => `${label} ${value}`).join("|");
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  el.replaceChildren(...items.map(([label, value]) => {
    const item = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = `${label} `;
    item.append(name, value);
    return item;
  }));
}

function renderLive() {
  const { dot, label, message } = liveStatus();
  liveEl("live-dot").className = `live-dot is-${dot}`;
  setLiveText("live-dot-label", label);
  setLiveText("live-empty", message);
  // 量測期間沒有新幀：圖表與 F4 變淡，不讓上一幀看起來像現在的數值。
  liveEl("live-spectrum").closest(".live-card").classList.toggle("is-paused", liveStreaming && liveDevice?.state === "MEASURING");
  renderSettings();
}

function clearLiveChart() {
  liveStreaming = false;
  liveChart?.destroy();
  liveChart = null;

  liveEl("live-spectrum").hidden = true;
  liveEl("live-f4").textContent = "--";
  liveEl("live-empty").hidden = false;
}

// ---- 圖表 ------------------------------------------------------------

function liveAspectRatio(width) {
  return width < LIVE_NARROW_CHART_PX ? 1.3 : 2.4;
}

function ensureLiveChart() {
  if (liveChart) return;
  const muted = liveCssVar("--muted");
  const ink = liveCssVar("--text");
  const rule = liveCssVar("--border");
  const ticks = { color: muted, font: { size: 10 } };
  const canvas = liveEl("live-chart");

  liveChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: LIVE_CHANNELS.map(liveChannelLines),
      datasets: [{ label: "Raw counts", data: LIVE_CHANNELS.map(() => 0), borderRadius: 3 }],
    },
    options: {
      responsive: true,
      aspectRatio: liveAspectRatio(canvas.parentElement.clientWidth),
      onResize: (chart, { width }) => {
        const ratio = liveAspectRatio(width);
        if (chart.options.aspectRatio === ratio) return;
        chart.options.aspectRatio = ratio;
        chart.resize();
      },
      animation: false,
      scales: {
        x: {
          title: { display: true, text: "Channel", color: ink },
          grid: { display: false },
          ticks: {
            ...ticks,
            autoSkip: false,
            maxRotation: 0,
            callback(value, index) {
              const channel = LIVE_CHANNELS[index];
              if (this.chart.width >= LIVE_NARROW_CHART_PX) return liveChannelLines(channel);
              return channel.short ?? channel.key;
            },
          },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "Raw counts", color: ink },
          grid: { color: rule },
          ticks: { ...ticks, maxTicksLimit: 5 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => liveChannelName(LIVE_CHANNELS[items[0].dataIndex]),
            label: (item) => `${liveCounts(item.parsed.y)} raw counts`,
          },
        },
      },
    },
  });
}

function drawLiveFrame(raw) {
  const accent = liveCssVar("--accent");
  const muted = liveCssVar("--muted");

  const values = LIVE_CHANNELS.map(({ key }) => raw[key]);
  const dataset = liveChart.data.datasets[0];
  dataset.data = values;
  dataset.backgroundColor = LIVE_CHANNELS.map(({ key }) => (key === "F4" ? accent : muted));
  // 只放大不縮小，長條才不會隨最高的通道一直跳；清空圖表後重新開始。
  const y = liveChart.options.scales.y;
  y.suggestedMax = Math.max(y.suggestedMax ?? 0, ...values);
  liveChart.update();

  liveEl("live-f4").textContent = liveCounts(raw.F4);
}

// ---- 訊息 ------------------------------------------------------------

function onLivePresence(message) {
  liveOnline = message.online === true;
  if (message.device) liveDevice = message.device;
  if (message.last_seen) liveLastSeen = message.last_seen;
  liveLastPresenceMs = Date.now();

  if (!liveOnline) clearLiveChart();
  renderLive();
}

function onLiveFrame(message) {
  const { raw } = message;
  const valid = raw && LIVE_CHANNELS.every(({ key }) => Number.isFinite(raw[key]))
    && Number.isFinite(message.seq) && Number.isFinite(message.t_ms);
  if (!valid) {
    console.error("Unexpected live frame:", message);
    return;
  }
  if (!liveWatching()) return;

  // 先顯示再建圖表：Chart.js 要量得到容器寬度才選得對長寬比。
  liveStreaming = true;
  liveEl("live-empty").hidden = true;
  liveEl("live-spectrum").hidden = false;
  ensureLiveChart();
  drawLiveFrame(raw);
  renderLive();
}

// ---- 連線 ------------------------------------------------------------

function sendLiveCommand() {
  if (liveSocket?.readyState === WebSocket.OPEN) {
    liveSocket.send(JSON.stringify({ cmd: liveWatching() ? "live_start" : "live_stop" }));
  }
}

function openLiveSocket() {
  clearTimeout(liveReconnectTimer);
  liveRetryAt = 0;
  const socket = new WebSocket(LIVE_URL);
  liveSocket = socket;
  renderLive();

  socket.onopen = () => {
    if (socket !== liveSocket) return;
    liveReconnectMs = LIVE_RECONNECT_MIN_MS;
    if (liveWatching()) sendLiveCommand();
    renderLive();
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
    clearLiveChart();
    liveRetryAt = Date.now() + liveReconnectMs;
    liveReconnectTimer = setTimeout(openLiveSocket, liveReconnectMs);
    liveReconnectMs = Math.min(liveReconnectMs * 2, LIVE_RECONNECT_MAX_MS);
    renderLive();
  };
}

function setLiveWanted(wanted) {
  liveWanted = wanted;
  sendLiveCommand();
  clearLiveChart();
  renderLive();
}

function tickLive() {
  if (liveOnline && Date.now() - liveLastPresenceMs > LIVE_PRESENCE_STALE_MS) {
    liveOnline = false;
    clearLiveChart();
  }
  renderLive();
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = liveEl("live-toggle");
  toggle.addEventListener("change", () => setLiveWanted(toggle.checked));

  clearLiveChart();
  openLiveSocket();
  setInterval(tickLive, LIVE_TICK_MS);

  // 分頁切到背景就沒人看得到：叫 LED 關掉；回到前景再開，開關維持原樣。
  document.addEventListener("visibilitychange", () => {
    if (!liveWanted) return;
    sendLiveCommand();
    clearLiveChart();
    renderLive();
  });
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
