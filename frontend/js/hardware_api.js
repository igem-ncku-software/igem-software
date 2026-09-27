// =========================================================
// CAPTURE-Screen's API layer: the one interface between the hardware pages and the
// device / storage.
//
// Device: CAPTURE-Screen dials into the backend itself (firmware/capture_screen); pages only ever
// talk to the backend:
//   GET  /api/hardware/status  whether the device is online, and its config
//   POST /api/hardware/read    takes one measurement, returning the device's raw reading,
//                              which js/hardware_processing.js then converts to a Measurement
// runs / curves / batches / fitting / conversion: js/hardware_local.js (the browser-side
// stand-in storage). Once the backend has storage, swapping those functions for fetch calls is
// enough — pages don't need to change.
//
// Every value going in or out of storage is structuredClone'd: a page mutating the returned
// object can never quietly mutate storage's own internal state.
//
// Load order: config -> hardware_processing -> hardware_local -> this file
// =========================================================

// ---- Data contract (shared between frontend and backend — don't rename these fields) -------------------------

/**
 * @typedef {"SATURATED" | "NO_DARK_PAIR" | "HIGH_SCATTER" | "STALE_CONFIG"} QCFlag
 */

/**
 * @typedef {Object} HardwareConfig
 * @property {string} fingerprint        Result of HardwareProcessing.configFingerprint(), e.g. "a7f21c"
 * @property {number} led_current_mA
 * @property {number} gain
 * @property {number} atime
 * @property {number} astep
 * @property {string} build_id           "P1-PROTO-01"; changed on purpose when the reading path changes
 * @property {string | null} emission_filter  currently null, not yet chosen
 */

/**
 * What a curve is valid for beyond the instrument config.
 * @typedef {Object} Conditions
 * @property {string} sensor             the biosensor strain / construct
 * @property {number} induction_h        hours from adding AHL to reading
 * @property {string} notes              free text, may be empty
 */

/**
 * @typedef {Object} Measurement
 * @property {string} sample_id
 * @property {string} timestamp_utc      ISO time of the read; a manual entry carries only its date (YYYY-MM-DD)
 * @property {"blank" | "standard" | "unknown"} sample_type
 * @property {number | null} known_concentration_nM  only set when sample_type is standard
 * @property {string} signal             what fluorescence is (HardwareProcessing.signalId), e.g. "F4"
 * @property {number} fluorescence       the sfGFP signal, basic counts
 * @property {number | null} fluorescence_sd  estimated standard deviation of read noise (from the two dark frames), basic counts; null for a manual entry
 * @property {number | null} scatter     the scatter component, an interference indicator, basic counts; null for a manual entry
 * @property {QCFlag[]} flags
 * @property {string} config_fingerprint
 * @property {Record<string, number> | null} raw  F1..F8, Clear, NIR — dark-subtracted basic counts; null for a manual entry
 * @property {"device" | "manual"} source  read by the instrument, or recorded earlier and entered by hand
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
 * A calibration run.
 * @typedef {Object} CalibrationPlan
 * @property {string} plan_id
 * @property {string} created_at
 * @property {"device" | "manual"} source  a run read on the instrument, or a dataset entered by hand (every slot already filled)
 * @property {string | null} measured_on  manual datasets only: the date the readings were taken (YYYY-MM-DD)
 * @property {string} config_fingerprint
 * @property {string} signal
 * @property {Conditions} conditions
 * @property {CalibrationPlanItem[]} items
 */

/**
 * @typedef {Object} CalibrationCurve
 * @property {string} curve_id
 * @property {string} fitted_at
 * @property {string} plan_id            the run it was fitted from
 * @property {"device" | "manual"} source  the source of that run
 * @property {"4PL"} model
 * @property {{top: number, bottom: number, ec50_nM: number, hill: number}} params
 * @property {number} lod_nM
 * @property {number} loq_nM
 * @property {number} rmse
 * @property {{min: number, max: number}} range_nM  the trusted conversion range
 * @property {{sample_id: string, reason: string}[]} excluded
 * @property {string} config_fingerprint
 * @property {string} signal
 * @property {Conditions} conditions
 */

/**
 * One group of tubes converted once: a sample's replicates, or a batch's blanks.
 * @typedef {Object} InverseEstimate
 * @property {"ok" | "below_lod" | "above_range" | "no_tubes"} status
 * @property {number | null} concentration_nM  only for "ok"; never extrapolated
 * @property {[number, number] | null} ci95_nM
 * @property {string} curve_id
 * @property {number} n                  tubes included
 * @property {number | null} mean_signal
 * @property {number | null} sd_signal   null below 2 tubes
 */

/**
 * @typedef {Object} BatchTube
 * @property {Measurement} measurement
 * @property {string | null} excluded_reason  null while it counts
 */

/**
 * One sitting at the instrument, converted through one curve.
 * @typedef {Object} MeasurementBatch
 * @property {string} batch_id
 * @property {string} created_at
 * @property {string | null} finished_at
 * @property {string | null} exported_at  cleared whenever a tube changes after an export
 * @property {string} curve_id
 * @property {{curve_id: string, conditions: Conditions, signal: string, config_fingerprint: string,
 *   lod_nM: number, loq_nM: number, range_nM: {min: number, max: number}}} curve  kept so an export reads without the curve
 * @property {number} tubes_per_sample
 * @property {string} notes
 * @property {BatchTube[]} blanks
 * @property {InverseEstimate} blank_estimate
 * @property {{name: string, tubes: BatchTube[], estimate: InverseEstimate}[]} samples
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
    const error = new Error(`Backend not reachable at ${BACKEND_BASE_URL}`);
    // For a page that must tell a backend that can't be reached from one that answered with an error.
    error.backendUnreachable = true;
    throw error;
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

async function hardwareCurrentSignal() {
  return HardwareProcessing.signalId(await loadUnmixBasis());
}

// ---- Functions exposed to pages -----------------------------------------------

const HardwareApi = {
  /**
   * Throws when the device is offline (with a message that can be shown as-is); pages should treat it as unreachable either way.
   * That error carries deviceOffline: true and lastSeen (ISO or null); one for a status that
   * doesn't validate carries deviceInvalid: true; an unreachable backend's carries
   * backendUnreachable: true — for a page that must say which link failed.
   * sensor_ok is null when the firmware predates the field: unknown, not healthy. It stays out
   * of HardwareConfig on purpose — sensor health must never reach the config fingerprint.
   * live_on / live_off_in_s / led_on are null from a firmware older than them, like sensor_ok.
   * @returns {Promise<{online: true, last_seen: string, config: HardwareConfig, sensor_ok: boolean | null,
   *   device_id: string, state: "IDLE" | "LIVE" | "MEASURING", wifi_rssi: number, uptime_ms: number,
   *   live_on: boolean | null, live_off_in_s: number | null, led_on: boolean | null}>}
   */
  async getDeviceStatus() {
    const body = await hardwareRequest("/status");
    if (!body.online) {
      const error = new Error(body.last_seen
        ? `CAPTURE-Screen is offline (last seen ${new Date(body.last_seen).toLocaleString()}).`
        : "CAPTURE-Screen has not connected to the backend. Power it on where it can reach its Wi-Fi.");
      error.deviceOffline = true;
      error.lastSeen = body.last_seen ?? null;
      throw error;
    }
    const problem = HardwareProcessing.validateDeviceStatus(body.device);
    if (problem) {
      console.error(`Unexpected device status (${problem}):`, body);
      const error = new Error("Unexpected response from device");
      error.deviceInvalid = true;
      throw error;
    }
    const { device } = body;
    return {
      online: true,
      last_seen: body.last_seen,
      config: HardwareProcessing.toHardwareConfig(device),
      sensor_ok: device.sensor_ok ?? null,
      device_id: device.device_id,
      state: device.state,
      wifi_rssi: device.wifi_rssi,
      uptime_ms: device.uptime_ms,
      live_on: device.live_on ?? null,
      live_off_in_s: device.live_off_in_s ?? null,
      led_on: device.led_on ?? null,
    };
  },

  /**
   * Instrument self-check: one buffer-only cuvette read, shown once and then discarded.
   * Deliberately not readSample({sample_type: "blank"}) — HIGH_SCATTER's baseline has to come
   * from a cell blank (cells at the standards' OD, no AHL), and going through readSample would
   * let a buffer check drop the baseline to a cell-free cuvette and flag every sample read afterwards.
   * So this never reaches HardwareLocal: the baseline is neither read nor written, and nothing is stored.
   * @returns {Promise<{timestamp_utc: string, config: HardwareConfig, dark_1: Record<string, number> | null,
   *   light: Record<string, number>, dark_2: Record<string, number> | null}>}  frames in integer counts
   */
  async runSelfCheck() {
    const reading = hardwareReading(await hardwareRequest("/read", { method: "POST" }));
    return HardwareProcessing.toSelfCheck(reading, new Date().toISOString());
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

  /** The signal id every new reading carries (HardwareProcessing.signalId). @returns {Promise<string>} */
  getCurrentSignal: () => hardwareCurrentSignal(),

  // ---- Calibration runs -----------------------------------------------------

  /**
   * A run is bound to the device's current config, so the device has to be checked before creating one.
   * @param {{concentrations_nM: number[], replicates: number, blanks: number, conditions: Conditions}} input
   * @returns {Promise<CalibrationPlan>}
   */
  async createCalibrationPlan(input) {
    const [status, signal] = await Promise.all([HardwareApi.getDeviceStatus(), hardwareCurrentSignal()]);
    return hardwareLocalCall(HardwareLocal.createCalibrationPlan, input, status.config.fingerprint, signal);
  },

  /**
   * The tube list createCalibrationPlan would make, in reading order, without creating anything.
   * Throws a displayable message for the first invalid field, like createCalibrationPlan.
   * @param {{concentrations_nM: number[], replicates: number, blanks: number}} input
   * @returns {{slot: number, label: string, sample_type: "blank" | "standard", concentration_nM: number | null}[]}
   */
  previewCalibrationPlan(input) {
    return structuredClone(HardwareLocal.previewCalibrationPlan(structuredClone(input)));
  },

  /**
   * Fingerprint of a config entered by hand. Throws a displayable message for the first invalid field.
   * @param {{led_current_mA: number, gain: number, atime: number, astep: number, build_id: string}} config
   * @returns {string}
   */
  fingerprintConfig(config) {
    const { led_current_mA, gain, atime, astep } = config ?? {};
    const build_id = String(config?.build_id ?? "").trim();
    if (!(Number.isFinite(led_current_mA) && led_current_mA >= 0)) throw new Error("LED current must be a number ≥ 0.");
    if (!(Number.isFinite(gain) && gain > 0)) throw new Error("Gain must be a positive number.");
    if (!(Number.isInteger(atime) && atime >= 0)) throw new Error("ATIME must be an integer ≥ 0.");
    if (!(Number.isInteger(astep) && astep >= 0)) throw new Error("ASTEP must be an integer ≥ 0.");
    if (!build_id) throw new Error("Enter the build ID.");
    return HardwareProcessing.configFingerprint({ led_current_mA, gain, atime, astep, build_id });
  },

  /**
   * Readings recorded earlier, entered by hand. config null binds the dataset to the instrument's
   * current config (so the device must be online); otherwise the entered config is fingerprinted.
   * The values are taken to be the current signal definition's.
   * @param {{conditions: Conditions, measured_on: string,
   *   config: {led_current_mA: number, gain: number, atime: number, astep: number, build_id: string} | null,
   *   rows: {sample_type: "blank" | "standard", concentration_nM: number | null, fluorescence: number}[]}} input
   * @returns {Promise<CalibrationPlan>}
   */
  async createManualDataset(input) {
    const signal = await hardwareCurrentSignal();
    const fingerprint = input?.config
      ? HardwareApi.fingerprintConfig(input.config)
      : (await HardwareApi.getDeviceStatus()).config.fingerprint;
    return hardwareLocalCall(HardwareLocal.createManualDataset, input, fingerprint, signal);
  },

  /** @param {string} plan_id @returns {Promise<CalibrationPlan>} */
  getCalibrationPlan: (plan_id) => hardwareLocalCall(HardwareLocal.getCalibrationPlan, plan_id),

  /**
   * Every saved run, newest first, summarised for a list (no readings).
   * @returns {Promise<{plan_id: string, created_at: string, source: "device" | "manual",
   *   measured_on: string | null, config_fingerprint: string, signal: string, conditions: Conditions,
   *   total: number, read: number, curve_ids: string[]}[]>}
   */
  listCalibrationPlans: () => hardwareLocalCall(HardwareLocal.listCalibrationPlans),

  /**
   * @param {string} plan_id @param {number} slot @param {Measurement} m
   * @returns {Promise<CalibrationPlan>}
   */
  recordPlanMeasurement: (plan_id, slot, m) => hardwareLocalCall(HardwareLocal.recordPlanMeasurement, plan_id, slot, m),

  // ---- Curves -------------------------------------------------------------------

  /**
   * @param {string} plan_id @param {string[]} excluded_sample_ids
   * @returns {Promise<CalibrationCurve>}
   */
  fitCurve: (plan_id, excluded_sample_ids) => hardwareLocalCall(HardwareLocal.fitCurve, plan_id, excluded_sample_ids),

  /**
   * Saves a fitted curve; every excluded tube needs a reason. A saved curve never changes.
   * @param {CalibrationCurve} curve @returns {Promise<CalibrationCurve>}
   */
  saveCurve: (curve) => hardwareLocalCall(HardwareLocal.saveCurve, curve),

  /** Newest first. @returns {Promise<CalibrationCurve[]>} */
  listCurves: () => hardwareLocalCall(HardwareLocal.listCurves),

  /** @param {string} curve_id @returns {Promise<CalibrationCurve>} */
  getCurve: (curve_id) => hardwareLocalCall(HardwareLocal.getCurve, curve_id),

  // ---- Measurement batches --------------------------------------------------------

  /**
   * Starts a batch on one curve. The curve has to match the instrument's config and the current
   * signal, so the device must be online.
   * @param {{curve_id: string, tubes_per_sample: number, notes: string}} input
   * @returns {Promise<MeasurementBatch>}
   */
  async createBatch(input) {
    const [status, signal] = await Promise.all([HardwareApi.getDeviceStatus(), hardwareCurrentSignal()]);
    return hardwareLocalCall(HardwareLocal.createBatch, input, status.config.fingerprint, signal);
  },

  /** @param {string} batch_id @returns {Promise<MeasurementBatch>} */
  getBatch: (batch_id) => hardwareLocalCall(HardwareLocal.getBatch, batch_id),

  /**
   * Newest first, summarised for a list.
   * @returns {Promise<{batch_id: string, created_at: string, finished_at: string | null, exported_at: string | null,
   *   curve_id: string, conditions: Conditions, blanks: number, samples: number, tubes: number}[]>}
   */
  listBatches: () => hardwareLocalCall(HardwareLocal.listBatches),

  /**
   * Stores one tube the moment it is read. role "blank" or "sample"; sample_name is ignored for a blank.
   * @param {string} batch_id @param {"blank" | "sample"} role @param {string | null} sample_name @param {Measurement} m
   * @returns {Promise<MeasurementBatch>}
   */
  recordBatchReading: (batch_id, role, sample_name, m) =>
    hardwareLocalCall(HardwareLocal.recordBatchReading, batch_id, role, sample_name, m),

  /**
   * reason null puts the tube back; a non-empty string leaves it out.
   * @param {string} batch_id @param {string} sample_id @param {string | null} reason
   * @returns {Promise<MeasurementBatch>}
   */
  setBatchTubeExclusion: (batch_id, sample_id, reason) =>
    hardwareLocalCall(HardwareLocal.setBatchTubeExclusion, batch_id, sample_id, reason),

  /** No more tubes after this. @param {string} batch_id @returns {Promise<MeasurementBatch>} */
  finishBatch: (batch_id) => hardwareLocalCall(HardwareLocal.finishBatch, batch_id),

  /** @param {string[]} batch_ids */
  markBatchesExported: (batch_ids) => hardwareLocalCall(HardwareLocal.markBatchesExported, batch_ids),

  // ---- Data --------------------------------------------------------------------

  /**
   * What a reset would delete, for showing before the user confirms. Deletes nothing.
   * @returns {Promise<{runs: number, curves: number, batches: number, unexported_batches: number,
   *   keys: number, in_memory: boolean}>}
   */
  getResetPreview: () => hardwareLocalCall(HardwareLocal.resetPreview),

  /**
   * Deletes everything this software stores in the browser and restores the defaults. IRREVERSIBLE:
   * call it only after the user has confirmed. Reports what is still there afterwards rather than
   * assuming the removal worked.
   * @returns {Promise<{removed: string[], remaining: string[], storage_unavailable: boolean}>}
   */
  resetAll: () => hardwareLocalCall(HardwareLocal.resetAll),

  /**
   * Everything this browser holds, as one backup file: runs, curves (with the fit internals
   * listCurves() leaves out) and batches.
   * @returns {Promise<{format: string, version: number, exported_at: string,
   *   plans: CalibrationPlan[], curves: CalibrationCurve[], batches: MeasurementBatch[]}>}
   */
  exportBackup: () => hardwareLocalCall(HardwareLocal.exportBackup),

  /**
   * Restores a parsed backup file. The payload is untrusted and validated entry by entry; an id
   * already stored is skipped rather than replaced. Throws with a displayable message when the
   * file itself isn't one this build reads.
   * @param {unknown} payload
   * @returns {Promise<Record<"plans" | "curves" | "batches",
   *   {imported: string[], skipped: string[], rejected: {id: string, reason: string}[]}>>}
   */
  importBackup: (payload) => hardwareLocalCall(HardwareLocal.importBackup, payload),

  /** @returns {Promise<UnmixBasis>} */
  getUnmixBasis: () => loadUnmixBasis(),
};
