// =========================================================
// CAPTURE-Screen 的 API 層：hardware 頁面跟裝置 / 儲存之間唯一的介面。
//
// 裝置：CAPTURE-Screen 自己連上後端（firmware/as7341），頁面只跟後端說話：
//   GET  /api/hardware/status  裝置在不在線、組態
//   POST /api/hardware/read    量一次，拿回裝置的原始讀值，再由
//                              js/hardware_processing.js 轉成 Measurement
// plan / curve / fit / invert：js/hardware_local.js（瀏覽器端的暫代儲存）。
// 之後後端有了儲存，把那幾個函式換成 fetch 即可，頁面不用改。
//
// 進出儲存端都做一次 structuredClone：頁面改到回傳的物件，不會偷偷改到
// 儲存端的內部狀態。
//
// 載入順序：config → hardware_processing → hardware_local → 這支
// =========================================================

// ---- 資料契約（前後端共用，欄位名稱不要改） -------------------------

/**
 * @typedef {"SATURATED" | "NO_DARK_PAIR" | "HIGH_SCATTER" | "STALE_CONFIG" | "BELOW_LOD" | "ABOVE_RANGE"} QCFlag
 */

/**
 * @typedef {Object} HardwareConfig
 * @property {string} fingerprint        HardwareProcessing.configFingerprint() 的結果，例如 "a7f21c"
 * @property {number} led_current_mA
 * @property {number} gain
 * @property {number} atime
 * @property {number} astep
 * @property {string} build_id           "P1-PROTO-01"
 * @property {string} firmware_version
 * @property {string | null} emission_filter  目前為 null，尚未選定
 */

/**
 * @typedef {Object} Measurement
 * @property {string} sample_id
 * @property {string} timestamp_utc
 * @property {"blank" | "standard" | "unknown"} sample_type
 * @property {number | null} known_concentration_nM  sample_type 為 standard 時才有值
 * @property {number} fluorescence       解混後的 sfGFP 訊號，basic counts
 * @property {number} fluorescence_sd    讀取雜訊的標準差估計（由兩張 dark 估計），basic counts
 * @property {number} scatter            散射分量，干擾指標，basic counts
 * @property {QCFlag[]} flags
 * @property {string} config_fingerprint
 * @property {Record<string, number>} raw  F1..F8, Clear, NIR，dark 扣除後的 basic counts
 */

/**
 * @typedef {Object} CalibrationPlanItem
 * @property {number} slot               1-based，使用者要依序跑的順序
 * @property {string} label              例如 "100 nM r2"、"blank r1"
 * @property {"blank" | "standard"} sample_type
 * @property {number | null} concentration_nM
 * @property {Measurement | null} measurement  尚未量測時為 null
 */

/**
 * @typedef {Object} CalibrationPlan
 * @property {string} plan_id
 * @property {string} created_at
 * @property {string} config_fingerprint
 * @property {string} timepoint          例如 "t=6h endpoint"
 * @property {CalibrationPlanItem[]} items
 */

/**
 * @typedef {Object} CalibrationCurve
 * @property {string} curve_id
 * @property {string} fitted_at
 * @property {"4PL"} model
 * @property {{top: number, bottom: number, ec50_nM: number, hill: number}} params
 * @property {number} lod_nM
 * @property {number} loq_nM
 * @property {number} rmse
 * @property {{min: number, max: number}} range_nM  可信的反推範圍
 * @property {{sample_id: string, reason: string}[]} excluded
 * @property {string} config_fingerprint
 * @property {string} timepoint
 * @property {boolean} is_active
 */

/**
 * @typedef {Object} InverseEstimate
 * @property {number | null} concentration_nM
 * @property {[number, number] | null} ci95_nM
 * @property {"ok" | "below_lod" | "above_range" | "no_curve" | "config_mismatch"} status
 * @property {string | null} curve_id
 */

/**
 * 解混基底（config/unmix_basis.json）。
 * @typedef {Object} UnmixBasis
 * @property {string} version            以 "placeholder" 開頭表示尚未標定
 * @property {string} note
 * @property {"single_channel"} method
 * @property {string} signal_channel
 * @property {string} scatter_channel
 */

// ---- 傳輸層 -----------------------------------------------------------

const HARDWARE_API_URL = `${BACKEND_BASE_URL}/api/hardware`;
const HARDWARE_BASIS_URL = "config/unmix_basis.json";
// 量測本身約 3 秒、後端最多等裝置 10 秒；睡著的 Render 後端被叫醒還要再幾十秒。
const HARDWARE_REQUEST_TIMEOUT_MS = 60000;

// 錯誤一律轉成可以直接顯示的訊息，頁面顯示 err.message 即可。
async function hardwareRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARDWARE_REQUEST_TIMEOUT_MS);
  let res;
  let body;
  try {
    res = await fetch(`${HARDWARE_API_URL}${path}`, { ...options, cache: "no-store", signal: controller.signal });
    body = await res.json().catch(() => null);
  } catch (err) {
    throw new Error(`Backend not reachable at ${BACKEND_BASE_URL}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `Backend returned HTTP ${res.status}`);
  if (!body || typeof body !== "object") {
    console.error(`Unexpected response from ${path}:`, body);
    throw new Error("Unexpected response from backend");
  }
  return body;
}

async function hardwareLocalCall(handler, ...args) {
  return structuredClone(handler(...structuredClone(args)));
}

function hardwareReading(body) {
  const problem = HardwareProcessing.validateDeviceReading(body);
  if (problem) {
    console.error(`Unexpected reading from device (${problem}):`, body);
    throw new Error("Unexpected response from device");
  }
  return body;
}

let hardwareBasisPromise = null;

function loadUnmixBasis() {
  if (!hardwareBasisPromise) {
    hardwareBasisPromise = fetch(HARDWARE_BASIS_URL, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        hardwareBasisPromise = null; // 下次再試
        throw new Error(`Could not load the unmixing basis (${HARDWARE_BASIS_URL}): ${err.message}`);
      });
  }
  return hardwareBasisPromise.then((basis) => structuredClone(basis));
}

async function hardwareCurrentFingerprint() {
  try {
    return (await HardwareApi.getDeviceStatus()).config.fingerprint;
  } catch (err) {
    return null;
  }
}

// ---- 對頁面公開的函式 -----------------------------------------------

const HardwareApi = {
  /**
   * 裝置不在線時丟出錯誤（訊息可直接顯示），頁面一律當作連不上處理。
   * @returns {Promise<{online: true, last_seen: string, config: HardwareConfig,
   *   device_id: string, state: "IDLE" | "LIVE" | "MEASURING", wifi_rssi: number, uptime_ms: number}>}
   */
  async getDeviceStatus() {
    const body = await hardwareRequest("/status");
    if (!body.online) {
      throw new Error(body.last_seen
        ? `CAPTURE-Screen is offline (last seen ${new Date(body.last_seen).toLocaleString()}).`
        : "CAPTURE-Screen has not connected to the backend. Power it on where it can reach its Wi-Fi.");
    }
    const problem = HardwareProcessing.validateDeviceStatus(body.device);
    if (problem) {
      console.error(`Unexpected device status (${problem}):`, body);
      throw new Error("Unexpected response from device");
    }
    const { device } = body;
    return {
      online: true,
      last_seen: body.last_seen,
      config: HardwareProcessing.toHardwareConfig(device),
      device_id: device.device_id,
      state: device.state,
      wifi_rssi: device.wifi_rssi,
      uptime_ms: device.uptime_ms,
    };
  },

  /** @returns {Promise<Measurement>} */
  async runDarkRead() {
    const reading = hardwareReading(await hardwareRequest("/read", { method: "POST" }));
    return HardwareProcessing.toDarkCheckMeasurement(reading, `DARK-${Date.now()}`, new Date().toISOString());
  },

  /**
   * @param {{sample_id: string, sample_type: "blank" | "standard" | "unknown", known_concentration_nM?: number}} input
   * @returns {Promise<Measurement>}
   */
  async readSample(input) {
    // 先檢查輸入、載入基底：有問題就不要讓裝置白白亮一次 LED。
    const inputError = HardwareProcessing.validateSampleInput(input);
    if (inputError) throw new Error(inputError);
    const basis = await loadUnmixBasis();

    const reading = hardwareReading(await hardwareRequest("/read", { method: "POST" }));
    const fingerprint = HardwareProcessing.toHardwareConfig(reading).fingerprint;
    const m = HardwareProcessing.toMeasurement(reading, structuredClone(input), {
      basis,
      blankScatter: HardwareLocal.measurementContext(fingerprint).blankScatter,
      timestampUtc: new Date().toISOString(),
    });
    return structuredClone(HardwareLocal.finalizeMeasurement(m));
  },

  /**
   * plan 綁定裝置目前的組態，所以建立時要先問裝置。
   * @param {{concentrations_nM: number[], replicates: number, blanks: number, timepoint: string}} input
   * @returns {Promise<CalibrationPlan>}
   */
  async createCalibrationPlan(input) {
    const status = await HardwareApi.getDeviceStatus();
    return hardwareLocalCall(HardwareLocal.createCalibrationPlan, input, status.config.fingerprint);
  },

  /** @param {string} plan_id @returns {Promise<CalibrationPlan>} */
  getCalibrationPlan: (plan_id) => hardwareLocalCall(HardwareLocal.getCalibrationPlan, plan_id),

  /**
   * @param {string} plan_id @param {number} slot @param {Measurement} m
   * @returns {Promise<CalibrationPlan>}
   */
  recordPlanMeasurement: (plan_id, slot, m) => hardwareLocalCall(HardwareLocal.recordPlanMeasurement, plan_id, slot, m),

  /**
   * @param {string} plan_id @param {string[]} excluded_sample_ids
   * @returns {Promise<CalibrationCurve>}
   */
  fitCurve: (plan_id, excluded_sample_ids) => hardwareLocalCall(HardwareLocal.fitCurve, plan_id, excluded_sample_ids),

  /**
   * 新擬合的曲線：存檔（excluded 要帶理由）。已存檔的曲線：只切換 is_active。
   * 設為 active 時會向裝置確認目前組態。
   * @param {CalibrationCurve} curve @returns {Promise<CalibrationCurve>}
   */
  async saveCurve(curve) {
    const fingerprint = curve?.is_active ? await hardwareCurrentFingerprint() : null;
    return hardwareLocalCall(HardwareLocal.saveCurve, curve, fingerprint);
  },

  /** @returns {Promise<CalibrationCurve[]>} */
  listCurves: () => hardwareLocalCall(HardwareLocal.listCurves),

  /** @returns {Promise<CalibrationCurve | null>} */
  getActiveCurve: () => hardwareLocalCall(HardwareLocal.getActiveCurve),

  /**
   * @param {number} fluorescence @param {string} config_fingerprint
   * @returns {Promise<InverseEstimate>}
   */
  invert: (fluorescence, config_fingerprint) => hardwareLocalCall(HardwareLocal.invert, fluorescence, config_fingerprint),

  /** @returns {Promise<UnmixBasis>} */
  getUnmixBasis: () => loadUnmixBasis(),
};
