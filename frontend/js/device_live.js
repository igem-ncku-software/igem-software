// =========================================================
// The landing page's CAPTURE-Screen live spectrum.
// Target elements:
//   #live-toggle / #led-toggle / #live-dot / #live-dot-label
//   #live-f4 / #live-f4-sub
//   #live-empty / #live-spectrum / #live-chart / #live-settings / #live-announce
// Depends on js/config.js (BACKEND_BASE_URL), js/hardware_processing.js (integration time and
// full scale, so the landing page and the workflow pages can't disagree on them), and Chart.js.
//
// Connects to WS /api/live/spectrum as soon as the page opens, so device presence is known
// right away. Live is ONE switch, owned by the device and shared by its button and every
// page: flipping this switch sends live_start / live_stop, and the switch then shows what
// the device reports (live_on in its status, relayed as presence) -- so a button press, or
// another browser, flips this switch too. Until the device answers, the switch shows the
// request; with no answer within LIVE_SWITCH_ANSWER_MS it falls back to the device's state.
// Neither closing nor hiding the tab switches Live off: the device switches itself off after
// 10 min (live_off_in_s), which bounds how long the LED heats and bleaches the sample.
//
// The LED switch works the same way (led_on / led_off, answered by the device's led_on), but
// only while Live is on: off, Live streams dark / ambient counts. The device resets it to on
// at every Live start. Each frame carries the LED state it was read with ("led"), and the
// page labels the frame by that, never by the switch, since a frame can predate a flip.
//
// Every fact lives in exactly one place:
//   the word next to the dot       current status (liveStatus())
//   the message box                details and next step (liveStatus()): it stands in for
//                      the chart when there is none, and shrinks to one line above the
//                      chart when there is one, so no message is written out of sight
//   the settings row under the chart   gain, integration time, LED current, and full scale
//                      — the measurement configuration a raw count can't be read without.
//                      Device identity and Wi-Fi were removed: they don't affect that reading.
//   #live-announce (visually hidden)   what a screen reader hears: the same status, minus the
//                      seconds that tick in the visible text, so it isn't re-read every second
//
// Rules:
//   - Live data is only ever drawn; it's never written to storage, added to a plan, or fitted
//   - Only the sfGFP channel F4 is called out; no other channel is labelled, and the update rate isn't shown
//   - The chart is cleared whenever the device goes offline or the connection drops — the last
//     frame is never left showing as if it were current
//   - Reconnects automatically on disconnect (a sleeping Render backend can take tens of
//     seconds to wake), no page reload needed — except when the backend rejects this page's
//     origin, which no retry can fix, so it stops and says so
//   - "Waiting for first frame" has an end: sensor_ok false names a dead AS7341, and
//     LIVE_FIRST_FRAME_MS names a device that switched Live on and then sent nothing
//   - The switch is disabled whenever the device can't take it, and the status says why
// =========================================================

const LIVE_URL = `${BACKEND_BASE_URL.replace(/^http/, "ws")}/api/live/spectrum`;
const LIVE_RECONNECT_MIN_MS = 1000;
const LIVE_RECONNECT_MAX_MS = 15000;
// The backend pushes offline on its own once the device goes silent, and sends presence at
// least every 10 s in every state (app/live/hub.py's PRESENCE_HEARTBEAT_SECONDS), so going
// this long without one means the browser-to-backend connection has quietly dropped.
const LIVE_PRESENCE_STALE_MS = 20000;
// Once a second: the reconnect countdown and "last seen … ago" need to keep advancing.
const LIVE_TICK_MS = 1000;
// A first frame needs the LED settle plus one read (~0.6 s), or ~2 s if a measurement was
// already running. Past this, Live was accepted but nothing is coming.
const LIVE_FIRST_FRAME_MS = 8000;
// The device answers a switch flip with a status straight away; past this, the request is
// taken as lost and the switch shows the device's own state again.
const LIVE_SWITCH_ANSWER_MS = 5000;
// Below this chart width (mobile), a 2.4 aspect ratio leaves only ~100 px of height and no
// room for ten axis labels: switch to a near-square ratio with channel codes only as labels.
const LIVE_NARROW_CHART_PX = 480;
// Where the y axis starts. A bar above it steps the axis up to the next 1/2/5 × 10^n, and it
// stays there until the chart is cleared. 5,000 was chosen by the user.
const LIVE_Y_BASE_COUNTS = 5000;

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
let livePending = null;    // {on, at}: a switch flip the device hasn't answered yet
let ledPending = null;     // the same for the LED switch
let liveFrameLit = true;    // whether the frame on the chart was read with the LED on
let liveOnline = false;     // the backend's most recent word on whether the device is online
let liveDevice = null;      // the device's most recently reported status
let liveLastSeen = null;
let liveLastPresenceMs = 0;
let liveStreaming = false;  // at least one frame has arrived since Live was turned on, and the chart is showing it
let liveWatchStartedMs = 0; // when the device last started streaming, for the first-frame timeout
let liveOffAt = 0;          // local time the device will switch Live off; 0 while it's off
let liveFatal = null;       // a rejection no reconnect can fix, so the retry loop stops
let liveChart = null;

// ---- Small helpers ----------------------------------------------------------

function liveEl(id) {
  return document.getElementById(id);
}

// Skip resetting when the content hasn't changed: #live-announce is an aria-live region, and resetting it every second would make a screen reader keep re-announcing it.
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

// The device's Live switch. A firmware older than live_on only reports its state.
function liveDeviceOn() {
  if (!liveOnline || !liveDevice) return false;
  return liveDevice.live_on ?? liveDevice.state === "LIVE";
}

// Why the switch can't be used right now, or null. The status next to it says the same.
function liveSwitchBlocked() {
  if (liveFatal || liveSocket?.readyState !== WebSocket.OPEN) return "Not connected to the backend";
  if (!liveOnline) return "CAPTURE-Screen is offline";
  if (liveDevice?.sensor_ok === false) return "AS7341 not responding";
  if (liveDevice?.state === "MEASURING") return "Measurement in progress";
  return null;
}

// The device's LED switch within Live; null from a firmware older than it (always lit).
function liveDeviceLed() {
  return typeof liveDevice?.led_on === "boolean" ? liveDevice.led_on : null;
}

function ledSwitchBlocked() {
  const blocked = liveSwitchBlocked();
  if (blocked) return blocked;
  if (liveDeviceLed() === null) return "This firmware has no LED switch";
  if (!liveDeviceOn()) return "Turn on Live first";
  return null;
}

function liveTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---- Status ------------------------------------------------------------

function liveStatus() {
  if (liveFatal) {
    return { dot: "off", label: "Blocked", message: liveFatal };
  }
  if (liveSocket?.readyState !== WebSocket.OPEN) {
    const retryS = Math.ceil((liveRetryAt - Date.now()) / 1000);
    const retrying = liveRetryAt && retryS > 0;
    return {
      dot: "reconnecting",
      label: retrying ? "Reconnecting" : "Connecting",
      // A sleeping Render backend can take nearly a minute to wake — without saying so, it looks broken.
      message: retrying ? `Retrying in ${retryS} s` : "Backend may take up to a minute to wake",
      spoken: retrying ? "Retrying" : undefined,
    };
  }
  if (!liveOnline) {
    const seen = liveDevice && liveLastSeen;
    return {
      dot: "off",
      label: "Offline",
      message: seen ? `Last seen ${liveAgo(liveLastSeen)}` : "Waiting for CAPTURE-Screen",
      spoken: seen ? `Last seen at ${liveTime(Date.parse(liveLastSeen))}` : undefined,
    };
  }
  // The firmware refuses to stream without the AS7341, and says nothing further about it.
  if (liveDevice?.sensor_ok === false) {
    return { dot: "off", label: "Sensor fault", message: "Device online; AS7341 not responding" };
  }
  const measuring = liveDevice?.state === "MEASURING";
  if (!liveDeviceOn()) {
    return measuring
      ? { dot: "off", label: "Measuring", message: "Measurement in progress" }
      // The one place the page says Live lights the LED on the sample: the description no longer does.
      : { dot: "off", label: "Online", message: "Turn on Live to switch on the LED and stream" };
  }
  if (measuring) {
    return { dot: "reconnecting", label: "Measuring", message: "Live resumes after measurement" };
  }
  if (!liveStreaming) {
    if (Date.now() - liveWatchStartedMs > LIVE_FIRST_FRAME_MS) {
      return { dot: "off", label: "No data", message: "No frames received from device" };
    }
    return { dot: "reconnecting", label: "Starting", message: "Waiting for first frame" };
  }
  // A clock time rather than a countdown: it doesn't tick, so it needs no separate spoken text.
  const autoOff = liveOffAt ? `Live auto-off at ${liveTime(liveOffAt)}` : "";
  if (!liveFrameLit) {
    return { dot: "streaming", label: "LED off", message: ["Dark / ambient counts", autoOff].filter(Boolean).join(". ") };
  }
  return { dot: "streaming", label: "Streaming", message: autoOff };
}

function renderSettings() {
  const el = liveEl("live-settings");
  el.hidden = !liveDevice;
  if (!liveDevice) return;

  // Device identity and Wi-Fi strength were dropped at the user's request: they don't
  // change how a raw count should be read, unlike the four below.
  const { config } = liveDevice;
  const items = [
    ["Gain", `${config.gain}×`],
    ["Integration", `${HardwareProcessing.integrationTimeMs(config).toFixed(1)} ms`],
    ["LED", `${config.led_current_mA} mA`],
    ["Full scale", `${liveCounts(HardwareProcessing.fullScaleCounts(config))} counts`],
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

// A disabled switch says why in its title; the status line says the same.
function renderSwitch(id, blocked, checked) {
  const toggle = liveEl(id);
  toggle.disabled = Boolean(blocked);
  toggle.closest(".live-switch").title = blocked ?? "";
  toggle.checked = checked;
}

function renderLive() {
  if (livePending && Date.now() - livePending.at > LIVE_SWITCH_ANSWER_MS) livePending = null;
  if (ledPending && Date.now() - ledPending.at > LIVE_SWITCH_ANSWER_MS) ledPending = null;
  renderSwitch("live-toggle", liveSwitchBlocked(), livePending ? livePending.on : liveDeviceOn());
  // Shown on only while Live is: with Live off the LED is off, whatever the switch was left at.
  renderSwitch("led-toggle", ledSwitchBlocked(), ledPending ? ledPending.on : liveDeviceOn() && liveDeviceLed() !== false);
  const { dot, label, message, spoken = message } = liveStatus();
  liveEl("live-dot").className = `live-dot is-${dot}`;
  setLiveText("live-dot-label", label);
  // The one aria-live region. The visible text below carries ticking seconds; this doesn't,
  // so setLiveText() leaves it alone until the state itself changes.
  setLiveText("live-announce", spoken ? `${label}. ${spoken}` : label);

  // The box carries every message there is. With the chart up it shrinks to a single line
  // above it instead of standing in for it, so a measurement's "the stream comes back on
  // its own" reaches the user rather than being written into a hidden element.
  const empty = liveEl("live-empty");
  setLiveText("live-empty", message);
  empty.classList.toggle("is-inline", liveStreaming);
  // While the chart is up the line keeps its space whether or not it has something to say,
  // so the message a measurement brings doesn't shift the chart down and back two seconds later.
  empty.classList.toggle("is-silent", liveStreaming && !message);
  empty.hidden = !message && !liveStreaming;
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
  liveEl("live-f4-sub").textContent = "raw counts";
  liveFrameLit = true;
  // renderLive() owns the message box; every caller here reaches it before the next paint.
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
  const fluor = liveCssVar("--fluor");
  const ticks = { color: muted, font: { size: 10 } };
  const canvas = liveEl("live-chart");

  liveChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: LIVE_CHANNELS.map(liveChannelLines),
      datasets: [{
        label: "Raw counts",
        data: LIVE_CHANNELS.map(() => 0),
        // Set once here, not per frame: only F4 is ever called out, and the palette can't change under us.
        backgroundColor: LIVE_CHANNELS.map(({ key }) => (key === "F4" ? fluor : liveCssVar("--chart-muted"))),
        borderRadius: 3,
      }],
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
          // stepSize is set per frame in drawLiveFrame(); 11 leaves room for 0 plus ten steps.
          ticks: { ...ticks, maxTicksLimit: 11 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => liveChannelName(LIVE_CHANNELS[items[0].dataIndex]),
            label: (item) => `${liveCounts(item.parsed.y)} counts`,
          },
        },
      },
    },
  });
}

// The smallest 1, 2 or 5 × 10^n at or above value, so a stepped-up axis still ends on a round number.
function liveNiceCeil(value) {
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].find((m) => m * power >= value) * power;
}

function drawLiveFrame(raw, lit) {
  const values = LIVE_CHANNELS.map(({ key }) => raw[key]);
  liveChart.data.datasets[0].data = values;
  // Fixed at LIVE_Y_BASE_COUNTS, so the bars don't jump with every frame. A bar above the
  // current top steps it up rather than being cut off; it never steps back down (clearing the
  // chart starts over), and never goes past the ADC's full scale, which no count can exceed.
  const y = liveChart.options.scales.y;
  const peak = Math.max(...values);
  let top = y.max ?? LIVE_Y_BASE_COUNTS;
  if (peak > top) top = liveNiceCeil(peak);
  y.max = liveDevice ? Math.min(top, HardwareProcessing.fullScaleCounts(liveDevice.config)) : top;
  // A gridline every 1,000 counts (the user's choice). Once the axis has stepped past 10,000
  // that would be dozens of lines, so it switches to ten equal steps of the top instead.
  y.ticks.stepSize = y.max <= 10000 ? 1000 : y.max / 10;
  liveChart.update();

  liveEl("live-f4").textContent = liveCounts(raw.F4);
  liveEl("live-f4-sub").textContent = lit ? "raw counts" : "raw counts, LED off";
}

// ---- Messages ------------------------------------------------------------

function onLivePresence(message) {
  const wasOnline = liveOnline;
  const wasOn = liveDeviceOn();
  liveOnline = message.online === true;
  // Assigned outright, not only when set: the backend clears `device` the moment a new
  // socket attaches (a new session isn't vouched for until it reports), and keeping the
  // old one would show the previous device's build and config as if they were current.
  liveDevice = message.device ?? null;
  liveLastSeen = message.last_seen ?? null;
  liveLastPresenceMs = Date.now();
  const on = liveDeviceOn();
  if (livePending?.on === on) livePending = null;   // the device has answered
  // Answered, or moot: with Live off the device refuses it and the switch shows off anyway.
  if (ledPending && (liveDeviceLed() === ledPending.on || !on)) ledPending = null;
  const offIn = liveDevice?.live_off_in_s;
  liveOffAt = on && Number.isFinite(offIn) ? Date.now() + offIn * 1000 : 0;
  // Restart the first-frame clock rather than let a legitimate gap run it out: a measurement
  // pauses the stream, and a device that comes back resumes Live by itself.
  if (liveDevice?.state === "MEASURING" || (liveOnline && !wasOnline) || (on && !wasOn)) liveWatchStartedMs = Date.now();

  if (!on) clearLiveChart();
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
  if (!liveDeviceOn()) return;   // a frame that raced the switch going off

  // Show before building the chart: Chart.js needs to measure the container's width to pick the right aspect ratio.
  liveStreaming = true;
  // A firmware older than the LED switch sends no "led"; its frames were always lit.
  liveFrameLit = message.led !== false;
  liveEl("live-spectrum").hidden = false;
  ensureLiveChart();
  drawLiveFrame(raw, liveFrameLit);
  renderLive();
}

function onLiveError(message) {
  if (message.error === "origin_not_allowed") {
    // Only the backend's CORS_ORIGINS can fix this, so retrying is pointless: say so and stop.
    liveFatal = "Backend doesn't allow this page's origin";
    console.error(`The live backend rejected this page's origin (${location.origin}). Add it to the backend's CORS_ORIGINS.`);
    renderLive();
    return;
  }
  if (message.error === "device_offline") {
    livePending = null;   // nothing will answer: show the device's state again
    ledPending = null;
    renderLive();
    return;
  }
  console.error("The live backend rejected a command:", message);
}

// ---- Connection ------------------------------------------------------------


function openLiveSocket() {
  clearTimeout(liveReconnectTimer);
  liveRetryAt = 0;
  const socket = new WebSocket(LIVE_URL);
  liveSocket = socket;
  renderLive();

  socket.onopen = () => {
    if (socket !== liveSocket) return;
    liveReconnectMs = LIVE_RECONNECT_MIN_MS;
    liveLastPresenceMs = Date.now();  // the staleness clock starts when the socket opens
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
    else if (message.mode === "error") onLiveError(message);
  };

  socket.onclose = () => {
    if (socket === liveSocket) onLiveSocketLost();
  };
}

// The current socket is gone, closed or given up on: forget it, clear the chart, and schedule
// the reconnect. Any late event from the old socket fails the `socket !== liveSocket` checks.
function onLiveSocketLost() {
  liveSocket = null;
  liveOnline = false;
  livePending = null;
  ledPending = null;
  clearLiveChart();
  if (!liveFatal) {
    liveRetryAt = Date.now() + liveReconnectMs;
    liveReconnectTimer = setTimeout(openLiveSocket, liveReconnectMs);
    liveReconnectMs = Math.min(liveReconnectMs * 2, LIVE_RECONNECT_MAX_MS);
  }
  renderLive();
}

// A flip of the page's switch is a request to the device; the switch holds the requested
// position until the device's status confirms it (or LIVE_SWITCH_ANSWER_MS passes).
function requestLive(on) {
  if (liveSwitchBlocked()) {
    renderLive();
    return;
  }
  livePending = { on, at: Date.now() };
  liveSocket.send(JSON.stringify({ cmd: on ? "live_start" : "live_stop" }));
  renderLive();
}

function requestLed(on) {
  if (ledSwitchBlocked()) {
    renderLive();
    return;
  }
  ledPending = { on, at: Date.now() };
  liveSocket.send(JSON.stringify({ cmd: on ? "led_on" : "led_off" }));
  renderLive();
}

function tickLive() {
  // Presence arrives at least every 10 s whether or not a device is attached, so a longer
  // silence on an open socket means it died without a close frame. Give up on it here rather
  // than wait for its onclose: close() on a dead connection waits out the closing handshake,
  // which can take up to a minute, and nothing would reconnect in the meantime.
  if (liveSocket?.readyState === WebSocket.OPEN && Date.now() - liveLastPresenceMs > LIVE_PRESENCE_STALE_MS) {
    const socket = liveSocket;
    onLiveSocketLost();
    socket.close();
    return;
  }
  renderLive();
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = liveEl("live-toggle");
  toggle.addEventListener("change", () => requestLive(toggle.checked));
  const ledToggle = liveEl("led-toggle");
  ledToggle.addEventListener("change", () => requestLed(ledToggle.checked));

  clearLiveChart();
  openLiveSocket();
  setInterval(tickLive, LIVE_TICK_MS);
  // Closes the connection on leaving the page. Live stays as it is: the switch is shared.
  // The chart is cleared here too: the socket's own onclose is skipped (liveSocket is already
  // null), and a page restored from the back/forward cache would otherwise show the old frame.
  window.addEventListener("pagehide", () => {
    clearTimeout(liveReconnectTimer);
    const socket = liveSocket;
    liveSocket = null;
    socket?.close();
    liveOnline = false;
    clearLiveChart();
    renderLive();
  });
  // Coming back from the back/forward cache, page state is still intact — just reconnect.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !liveSocket) openLiveSocket();
  });
});
