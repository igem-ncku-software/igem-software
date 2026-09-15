// =========================================================
// CAPTURE-Screen 的 API 層：hardware 頁面跟裝置 / 儲存之間唯一的介面。
//
// 依 js/config.js 的 DEVICE_MODE 選擇裝置的實作，對外的函式簽章不變：
//   mock  getDeviceStatus / runDarkRead / readSample 走 js/hardware_mock.js
//   live  同上三個走 js/hardware_device.js（真實裝置），再由
//         js/hardware_processing.js 轉成 Measurement
// plan / curve / fit / invert 兩種模式都走 js/hardware_local.js（瀏覽器端的
// 暫代後端）。之後後端完成，把這些函式換成 fetch(`${BACKEND_BASE_URL}/api/hardware/...`)
// 即可，頁面不用改。
//
// 進出都做一次 structuredClone，模擬資料經過 HTTP 序列化：頁面改到回傳的
// 物件，不會偷偷改到儲存端的內部狀態。
//
// 載入順序：config → hardware_processing → hardware_local → hardware_mock →
//           hardware_device → 這支
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

const HARDWARE_MOCK_DELAY_MS = [300, 800];
const HARDWARE_BASIS_URL = "config/unmix_basis.json";
const HARDWARE_USE_DEVICE = DEVICE_MODE === "live";

// 瀏覽器端的呼叫（mock 裝置與暫代後端）加上假延遲，讓 loading 狀態真的會出現。
async function hardwareLocalCall(handler, ...args) {
  const [min, max] = HARDWARE_MOCK_DELAY_MS;
  const payload = structuredClone(args);
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
  return structuredClone(handler(...payload));
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
  /** @returns {Promise<{online: boolean, last_seen: string, config: HardwareConfig}>} */
  async getDeviceStatus() {
    if (!HARDWARE_USE_DEVICE) return hardwareLocalCall(HardwareMock.deviceStatus);
    const body = await HardwareDevice.status();
    return { online: true, last_seen: new Date().toISOString(), config: HardwareProcessing.toHardwareConfig(body) };
  },

  /** @returns {Promise<Measurement>} */
  async runDarkRead() {
    if (!HARDWARE_USE_DEVICE) return hardwareLocalCall(HardwareMock.darkRead);
    const reading = await HardwareDevice.read();
    return HardwareProcessing.toDarkCheckMeasurement(reading, `DARK-${Date.now()}`, new Date().toISOString());
  },

  /**
   * @param {{sample_id: string, sample_type: "blank" | "standard" | "unknown", known_concentration_nM?: number}} input
   * @returns {Promise<Measurement>}
   */
  async readSample(input) {
    // 先載入基底：基底有問題就不要讓裝置白白亮一次 LED。
    const basis = await loadUnmixBasis();
    if (!HARDWARE_USE_DEVICE) return hardwareLocalCall(HardwareMock.readSample, input, basis);

    const inputError = HardwareProcessing.validateSampleInput(input);
    if (inputError) throw new Error(inputError);
    const reading = await HardwareDevice.read();
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

  /**
   * 裝置若還在即時串流（LIVE），先把它停掉。mock 模式沒有串流，直接回 false。
   * @returns {Promise<boolean>} 是否真的停了一個串流
   */
  async ensureLiveStopped() {
    if (!HARDWARE_USE_DEVICE) return false;
    return HardwareDevice.stopLiveIfStreaming();
  },
};
