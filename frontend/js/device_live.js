// =========================================================
// The landing page's CAPTURE-Screen live spectrum.
// Target elements:
//   #live-toggle / #live-dot / #live-dot-label
//   #live-f4
//   #live-empty / #live-spectrum / #live-chart / #live-settings
// Depends on js/config.js (BACKEND_BASE_URL) and Chart.js.
//
// Connects to WS /api/live/spectrum as soon as the page opens, so device presence is known
// right away; live_start is only sent while the Live switch is on AND the tab is in the
// foreground. The backend counts every watching browser, and the device's LED only lights
// up while someone is watching (leaving it on would heat and bleach the sample), so the
// switch defaults off, and moving the tab to the background turns it off too, resuming when
// the tab comes back.
//
// Every fact lives in exactly one place:
//   the word next to the dot       current status (liveStatus())
//   the box where the chart sits   details and next step (liveStatus())
//   the settings row under the chart   which device, firmware, Wi-Fi (the last-reported
//                      device and no Wi-Fi once offline), plus gain, integration time,
//                      LED current, and full scale — without these the raw counts can't be interpreted
//
// Rules:
//   - Live data is only ever drawn; it's never written to storage, added to a plan, or fitted
//   - Only the sfGFP channel F4 is called out; leakage (F3) and the update rate aren't shown
//   - The chart is cleared whenever the device goes offline or the connection drops — the last
//     frame is never left showing as if it were current
//   - Reconnects automatically on disconnect (a sleeping Render backend can take tens of
//     seconds to wake), no page reload needed
// =========================================================

const LIVE_URL = `${BACKEND_BASE_URL.replace(/^http/, "ws")}/api/live/spectrum`;
const LIVE_RECONNECT_MIN_MS = 1000;
const LIVE_RECONNECT_MAX_MS = 15000;
// The backend pushes offline on its own once the device goes silent; but while online it
// sends a presence message every 5 s, so going this long without one means the browser-to-backend
// connection has quietly dropped.
const LIVE_PRESENCE_STALE_MS = 20000;
// Once a second: the reconnect countdown and "last seen … ago" need to keep advancing.
const LIVE_TICK_MS = 1000;
// Integration time and full scale use the same formula as hardware_processing.js: (ATIME+1)(ASTEP+1)
// steps, 2.78 µs each, with the ADC saturating at min(65535, (ATIME+1)(ASTEP+1)).
const LIVE_ADC_MAX_COUNTS = 65535;
const LIVE_ASTEP_UNIT_MS = 2.78e-3;
// Below this chart width (mobile), a 2.4 aspect ratio leaves only ~100 px of height and no
// room for ten axis labels: switch to a near-square ratio with channel codes only as labels.
const LIVE_NARROW_CHART_PX = 480;

// The landing page doesn't load hardware_common.js, so channel names are defined again here on their own.
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
let liveRetryAt = 0;        // time of the next reconnect attempt; 0 means not waiting
let liveWanted = false;     // the user has Live switched on
let liveOnline = false;     // the backend's most recent word on whether the device is online
let liveDevice = null;      // the device's most recently reported status
let liveLastSeen = null;
let liveLastPresenceMs = 0;
let liveStreaming = false;  // at least one frame has arrived since Live was turned on, and the chart is showing it
let liveChart = null;

// ---- Small helpers ----------------------------------------------------------

function liveEl(id) {
  return document.getElementById(id);
}

// Skip resetting when the content hasn't changed: #live-dot-label sits in an aria-live region, and resetting it every second would make a screen reader keep re-announcing it.
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

// ["F4", "515 nm"]: two lines on the chart axis; joined into one line for text.
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

// Live is on but the tab is backgrounded, so nobody can see it — the LED shouldn't be lit for that.
function liveWatching() {
  return liveWanted && !document.hidden;
}

// ---- Status ------------------------------------------------------------

function liveStatus() {
  if (liveSocket?.readyState !== WebSocket.OPEN) {
    const retryS = Math.ceil((liveRetryAt - Date.now()) / 1000);
    return {
      dot: "reconnecting",
      label: "Connecting",
      // A sleeping Render backend can take nearly a minute to wake — without saying so, it looks broken.
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
    // Wi-Fi strength is stale once offline, so it's left out.
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
  // No new frames arrive during a measurement: the chart and F4 fade, so the last frame doesn't look like a current value.
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

// ---- Chart ------------------------------------------------------------

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
  // Grows only, never shrinks, so the bars don't keep jumping around with the highest channel; resets when the chart is cleared.
  const y = liveChart.options.scales.y;
  y.suggestedMax = Math.max(y.suggestedMax ?? 0, ...values);
  liveChart.update();

  liveEl("live-f4").textContent = liveCounts(raw.F4);
}

// ---- Messages ------------------------------------------------------------

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

  // Show before building the chart: Chart.js needs to measure the container's width to pick the right aspect ratio.
  liveStreaming = true;
  liveEl("live-empty").hidden = true;
  liveEl("live-spectrum").hidden = false;
  ensureLiveChart();
  drawLiveFrame(raw);
  renderLive();
}

// ---- Connection ------------------------------------------------------------

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

  // Moving the tab to the background means nobody can see it: turn the LED off, and back on when it returns to the foreground — the switch itself stays as it was.
  document.addEventListener("visibilitychange", () => {
    if (!liveWanted) return;
    sendLiveCommand();
    clearLiveChart();
    renderLive();
  });
  // Closes the connection on leaving the page: the backend counts one fewer viewer, and turns the device's LED off itself once nobody is watching.
  window.addEventListener("pagehide", () => {
    clearTimeout(liveReconnectTimer);
    const socket = liveSocket;
    liveSocket = null;
    socket?.close();
  });
  // Coming back from the back/forward cache, page state is still intact — just reconnect.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !liveSocket) openLiveSocket();
  });
});
