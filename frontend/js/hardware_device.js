// =========================================================
// CAPTURE-Screen 真實裝置的連線（DEVICE_MODE = "live"）。
// 對接 firmware/as7341：GET /status、POST /read、WebSocket /live。
//
// 只做 I/O 與回應格式檢查，不做任何資料處理（那是 hardware_processing.js
// 的事）。錯誤一律轉成使用者看得懂的訊息，頁面直接顯示 err.message：
//   連不上 / 逾時    "Device not reachable at {DEVICE_BASE_URL}"
//   HTTP 409         "Device is busy, try again"
//   JSON 格式不符    "Unexpected response from device"（原始回應印在 console）
//
// 依賴 js/config.js 的 DEVICE_BASE_URL 與 js/hardware_processing.js。
// =========================================================

const DEVICE_HTTP_TIMEOUT_MS = 8000;      // /read 本身約 0.5 s，其餘留給 Wi-Fi
const DEVICE_WS_STOP_TIMEOUT_MS = 3000;

async function deviceRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEVICE_HTTP_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(`${DEVICE_BASE_URL}${path}`, { ...options, signal: controller.signal, cache: "no-store" });
    text = await res.text();
  } catch (err) {
    throw new Error(`Device not reachable at ${DEVICE_BASE_URL}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 409) throw new Error("Device is busy, try again");
  if (!res.ok) throw new Error(`Device returned HTTP ${res.status}`);

  try {
    return { body: JSON.parse(text), text };
  } catch (err) {
    throw deviceUnexpected(text, "not JSON");
  }
}

function deviceUnexpected(text, detail) {
  console.error(`Unexpected response from device (${detail}):`, text);
  return new Error("Unexpected response from device");
}

const HardwareDevice = {
  liveUrl() {
    return `${DEVICE_BASE_URL.replace(/^http/, "ws")}/live`;
  },

  async status() {
    const { body, text } = await deviceRequest("/status");
    const problem = HardwareProcessing.validateDeviceStatus(body);
    if (problem) throw deviceUnexpected(text, problem);
    return body;
  },

  // 不帶 body 也不帶 Content-Type，讓瀏覽器當成 simple request、不必先送 preflight。
  async read() {
    const { body, text } = await deviceRequest("/read", { method: "POST" });
    const problem = HardwareProcessing.validateDeviceReading(body);
    if (problem) throw deviceUnexpected(text, problem);
    return body;
  },

  // 裝置若還在 LIVE（例如另一個分頁開著即時監看），連上 /live 送 live_stop。
  // 回傳是否真的停了一個串流。
  async stopLiveIfStreaming() {
    const body = await this.status();
    if (body.state !== "LIVE") return false;

    await new Promise((resolve) => {
      const socket = new WebSocket(this.liveUrl());
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch (err) {
          // 已經關了。
        }
        resolve();
      };
      const timer = setTimeout(finish, DEVICE_WS_STOP_TIMEOUT_MS);
      socket.onopen = () => {
        socket.send(JSON.stringify({ cmd: "live_stop" }));
        setTimeout(finish, 150); // 給裝置一點時間收到指令再關連線
      };
      socket.onerror = finish;
    });
    return true;
  },
};
