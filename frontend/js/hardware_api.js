// =========================================================
// CAPTURE-Screen's API layer: the one interface between the hardware pages and the
// device / storage.
//
// Device: CAPTURE-Screen dials into the backend itself (firmware/as7341); pages only ever
// talk to the backend:
//   GET  /api/hardware/status  whether the device is online, and its config
//   POST /api/hardware/read    takes one measurement, returning the device's raw reading,
//                              which js/hardware_processing.js then converts to a Measurement
// plan / curve / fit / invert: js/hardware_local.js (the browser-side stand-in storage).
// Once the backend has storage, swapping those functions for fetch calls is enough — pages
// don't need to change.
//
// Every value going in or out of storage is structuredClone'd: a page mutating the returned
// object can never quietly mutate storage's own internal state.
//
// Load order: config -> hardware_processing -> hardware_local -> this file
// =========================================================

// ---- Data contract (shared between frontend and backend — don't rename these fields) -------------------------

/**
 * @typedef {"SATURATED" | "NO_DARK_PAIR" | "HIGH_SCATTER" | "STALE_CONFIG" | "BELOW_LOD" | "ABOVE_RANGE"} QCFlag
 */

/**
 * @typedef {Object} HardwareConfig
 * @property {string} fingerprint        Result of HardwareProcessing.configFingerprint(), e.g. "a7f21c"
 * @property {number} led_current_mA
 * @property {number} gain
 * @property {number} atime
 * @property {number} astep
 * @property {string} build_id           "P1-PROTO-01"
 * @property {string} firmware_version
 * @property {string | null} emission_filter  currently null, not yet chosen
 */

/**
 * @typedef {Object} Measurement
 * @property {string} sample_id
 * @property {string} timestamp_utc
 * @property {"blank" | "standard" | "unknown"} sample_type
 * @property {number | null} known_concentration_nM  only set when sample_type is standard
 * @property {number} fluorescence       the unmixed sfGFP signal, basic counts
 * @property {number} fluorescence_sd    estimated standard deviation of read noise (from the two dark frames), basic counts
 * @property {number} scatter            the scatter component, an interference indicator, basic counts
 * @property {QCFlag[]} flags
 * @property {string} config_fingerprint
 * @property {Record<string, number>} raw  F1..F8, Clear, NIR — dark-subtracted basic counts
 */

/**
 * @typedef {Object} CalibrationPlanItem
 * @property {number} slot               1-based, the order the user should run them in
 * @property {string} label              e.g. "100 nM r2", "blank r1"
 * @property {"blank" | "standard"} sample_type
 * @property {number | null} concentration_nM
 * @property {Measurement | null} measurement  null until measured
 */

/**
 * @typedef {Object} CalibrationPlan
 * @property {string} plan_id
 * @property {string} created_at
 * @property {string} config_fingerprint
 * @property {string} timepoint          e.g. "t=6h endpoint"
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
 * @property {{min: number, max: number}} range_nM  the trusted inversion range
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
 * Unmixing basis (config/unmix_basis.json).
 * @typedef {Object} UnmixBasis
 * @property {string} version            starting with "placeholder" means it's not calibrated yet
 * @property {string} note
 * @property {"single_channel"} method
 * @property {string} signal_channel
 * @property {string} scatter_channel
 */

// ---- Transport layer -----------------------------------------------------------

const HARDWARE_API_URL = `${BACKEND_BASE_URL}/api/hardware`;
const HARDWARE_BASIS_URL = "config/unmix_basis.json";
// A measurement itself takes ~3 s, and the backend waits up to 10 s on the device; a sleeping
// Render backend being woken up can add several more tens of seconds on top of that.
const HARDWARE_REQUEST_TIMEOUT_MS = 60000;

// Every error is turned into a message that can be shown as-is; pages just display err.message.
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
        hardwareBasisPromise = null; // retry next time
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

// ---- Functions exposed to pages -----------------------------------------------

const HardwareApi = {
  /**
   * Throws when the device is offline (with a message that can be shown as-is); pages should treat it as unreachable either way.
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
    // Check the input and load the basis first: if something's wrong, don't waste a device LED cycle.
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
   * A plan is bound to the device's current config, so the device has to be checked before creating one.
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
   * A newly fitted curve: saved (excluded entries need a reason). An already-saved curve: only toggles is_active.
   * Setting it active confirms the current config against the device.
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
