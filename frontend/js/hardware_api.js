// =========================================================
// CAPTURE-Screen 的 API 層：hardware 頁面跟「後端」之間唯一的介面。
//
// 目前每個函式都是 mock（轉呼叫 js/hardware_mock.js，加 300–800 ms 假延遲），
// 但簽章和回傳型別就是正式介面。接真後端時只要把這支的函式內容換成
// fetch(`${BACKEND_BASE_URL}/api/hardware/...`)，頁面 script 一行都不用改。
//
// 進出都做一次 structuredClone，模擬資料經過 HTTP 序列化：頁面改到回傳的
// 物件，不會偷偷改到 mock 的內部狀態（真後端本來就不可能被這樣改到）。
//
// 依賴 js/hardware_mock.js，必須排在它後面載入。
// =========================================================

// ---- 資料契約（前後端共用，欄位名稱不要改） -------------------------

/**
 * @typedef {"SATURATED" | "NO_DARK_PAIR" | "HIGH_SCATTER" | "STALE_CONFIG" | "BELOW_LOD" | "ABOVE_RANGE"} QCFlag
 */

/**
 * @typedef {Object} HardwareConfig
 * @property {string} fingerprint        以下欄位的 hash，例如 "a7f21c"
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
 * @property {number} fluorescence_sd
 * @property {number} scatter            散射分量，干擾指標
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

// ---- mock 傳輸層 ---------------------------------------------------

const HARDWARE_MOCK_DELAY_MS = [300, 800];

function hardwareMockCall(handler, ...args) {
  const [min, max] = HARDWARE_MOCK_DELAY_MS;
  const delay = min + Math.random() * (max - min);
  const payload = structuredClone(args);
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(structuredClone(handler(...payload)));
      } catch (err) {
        reject(err);
      }
    }, delay);
  });
}

// ---- 對頁面公開的函式 -----------------------------------------------

const HardwareApi = {
  /** @returns {Promise<{online: boolean, last_seen: string, config: HardwareConfig}>} */
  getDeviceStatus: () => hardwareMockCall(HardwareMock.deviceStatus),

  /** @returns {Promise<Measurement>} */
  runDarkRead: () => hardwareMockCall(HardwareMock.darkRead),

  /**
   * @param {{sample_id: string, sample_type: "blank" | "standard" | "unknown", known_concentration_nM?: number}} input
   * @returns {Promise<Measurement>}
   */
  readSample: (input) => hardwareMockCall(HardwareMock.readSample, input),

  /**
   * @param {{concentrations_nM: number[], replicates: number, blanks: number, timepoint: string}} input
   * @returns {Promise<CalibrationPlan>}
   */
  createCalibrationPlan: (input) => hardwareMockCall(HardwareMock.createCalibrationPlan, input),

  /** @param {string} plan_id @returns {Promise<CalibrationPlan>} */
  getCalibrationPlan: (plan_id) => hardwareMockCall(HardwareMock.getCalibrationPlan, plan_id),

  /**
   * @param {string} plan_id @param {number} slot @param {Measurement} m
   * @returns {Promise<CalibrationPlan>}
   */
  recordPlanMeasurement: (plan_id, slot, m) => hardwareMockCall(HardwareMock.recordPlanMeasurement, plan_id, slot, m),

  /**
   * @param {string} plan_id @param {string[]} excluded_sample_ids
   * @returns {Promise<CalibrationCurve>}
   */
  fitCurve: (plan_id, excluded_sample_ids) => hardwareMockCall(HardwareMock.fitCurve, plan_id, excluded_sample_ids),

  /**
   * 新擬合的曲線：存檔（excluded 要帶理由）。已存檔的曲線：只切換 is_active。
   * @param {CalibrationCurve} curve @returns {Promise<CalibrationCurve>}
   */
  saveCurve: (curve) => hardwareMockCall(HardwareMock.saveCurve, curve),

  /** @returns {Promise<CalibrationCurve[]>} */
  listCurves: () => hardwareMockCall(HardwareMock.listCurves),

  /** @returns {Promise<CalibrationCurve | null>} */
  getActiveCurve: () => hardwareMockCall(HardwareMock.getActiveCurve),

  /**
   * @param {number} fluorescence @param {string} config_fingerprint
   * @returns {Promise<InverseEstimate>}
   */
  invert: (fluorescence, config_fingerprint) => hardwareMockCall(HardwareMock.invert, fluorescence, config_fingerprint),
};
