// =========================================================
// CAPTURE-Screen data processing: raw device reading (POST /api/hardware/read's response) -> Measurement.
//
// Everything here is a pure function: no DOM, no requests, no localStorage, no clock (time is
// passed in by the caller). This is meant to be ported verbatim to backend/app/hardware/, so the
// rules here — especially configFingerprint()'s concatenation format — must match exactly between
// frontend and backend.
//
// Units: Measurement's fluorescence / scatter / raw are all
//   basic counts = (light - dark) / (gain x integration_time_ms)
// =========================================================

const HardwareProcessing = (() => {
  const ADC_MAX_COUNTS = 65535;
  const ASTEP_UNIT_MS = 2.78e-3; // 2.78 µs per step
  const DEVICE_CHANNELS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "CLR", "NIR"];
  // The device uses CLR; the data contract (Measurement.raw) uses Clear.
  const CONTRACT_NAME = { CLR: "Clear" };
  // Standard deviation of ADC quantization error (uniform distribution over 1 count): the floor for the read-noise estimate.
  const QUANTIZATION_SD_COUNTS = 1 / Math.sqrt(12);
  const HIGH_SCATTER_RATIO = 2;
  const SAMPLE_TYPES = ["blank", "standard", "unknown"];

  // ---- Config -----------------------------------------------------------

  // Fixed order, fixed format: LED current to 3 decimal places, everything else stringified as-is,
  // joined with "|", then FNV-1a 32-bit over the UTF-8 bytes, keeping the first 6 hex digits.
  // The backend must use the exact same rule, or the same instrument's frontend and backend
  // would compute different fingerprints. There is no firmware version anywhere: a firmware
  // update that changes the reading path is marked by changing build_id.
  function configFingerprint(config) {
    const canonical = [
      Number(config.led_current_mA).toFixed(3),
      String(config.gain),
      String(config.atime),
      String(config.astep),
      String(config.build_id),
    ].join("|");
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(canonical)) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0").slice(0, 6);
  }

  function integrationTimeMs(config) {
    return (config.atime + 1) * (config.astep + 1) * ASTEP_UNIT_MS;
  }

  function fullScaleCounts(config) {
    return Math.min(ADC_MAX_COUNTS, (config.atime + 1) * (config.astep + 1));
  }

  // The two CAPTURE-Screen builds, by the device_id their firmware sends (firmware/capture_screen
  // and firmware/capture_screen_3d). One is connected at a time; an unknown id is shown as it is.
  const READER_NAMES = {
    "capture-screen-p1": "Laser-cut build",
    "capture-screen-3d": "3D-printed build",
  };

  function readerName(deviceId) {
    return READER_NAMES[deviceId] ?? deviceId ?? null;
  }

  function countsToBasic(counts, config) {
    return counts / (config.gain * integrationTimeMs(config));
  }

  // GET /status (or /read)'s response -> the data contract's HardwareConfig.
  function toHardwareConfig(body) {
    const config = {
      fingerprint: "",
      led_current_mA: body.config.led_current_mA,
      gain: body.config.gain,
      atime: body.config.atime,
      astep: body.config.astep,
      build_id: body.build_id,
      emission_filter: null, // the firmware doesn't know which filter is installed; none has been chosen yet either
    };
    config.fingerprint = configFingerprint(config);
    return config;
  }

  // ---- Validation: returns an error message string, or null if it's fine ---------------------------

  function isChannelFrame(frame) {
    return Boolean(frame) && typeof frame === "object"
      && DEVICE_CHANNELS.every((key) => Number.isFinite(frame[key]));
  }

  function validateDeviceConfig(config) {
    if (!config || typeof config !== "object") return "missing config";
    if (!Number.isFinite(config.led_current_mA)) return "config.led_current_mA isn't a number";
    if (!(Number.isFinite(config.gain) && config.gain > 0)) return "config.gain must be a positive number";
    if (!(Number.isInteger(config.atime) && config.atime >= 0)) return "config.atime must be a non-negative integer";
    if (!(Number.isInteger(config.astep) && config.astep >= 0)) return "config.astep must be a non-negative integer";
    return null;
  }

  function validateIdentity(body) {
    if (typeof body.build_id !== "string") return "build_id is missing";
    return null;
  }

  function validateDeviceStatus(body) {
    if (!body || typeof body !== "object") return "response isn't a JSON object";
    if (typeof body.device_id !== "string") return "device_id is missing";
    const identity = validateIdentity(body);
    if (identity) return identity;
    if (!["IDLE", "LIVE", "MEASURING"].includes(body.state)) return `unknown state ${body.state}`;
    // Optional: a firmware older than the field reports no sensor health at all, and that must
    // not cost the device its whole status. Absent means "unknown", never "fine".
    if (!(body.sensor_ok === undefined || body.sensor_ok === null || typeof body.sensor_ok === "boolean")) {
      return "sensor_ok must be a boolean when present";
    }
    // Optional for the same reason: the shared Live switch, and its auto-off countdown.
    if (!(body.live_on === undefined || body.live_on === null || typeof body.live_on === "boolean")) {
      return "live_on must be a boolean when present";
    }
    if (!(body.live_off_in_s === undefined || body.live_off_in_s === null
      || (Number.isInteger(body.live_off_in_s) && body.live_off_in_s >= 0))) {
      return "live_off_in_s must be a non-negative integer when present";
    }
    // The LED switch within Live (firmware 7.1.0 and later).
    if (!(body.led_on === undefined || body.led_on === null || typeof body.led_on === "boolean")) {
      return "led_on must be a boolean when present";
    }
    return validateDeviceConfig(body.config);
  }

  function validateDeviceReading(body) {
    if (!body || typeof body !== "object") return "response isn't a JSON object";
    if (body.mode !== "measurement") return `mode is "${body.mode}", expected "measurement"`;
    const identity = validateIdentity(body);
    if (identity) return identity;
    const config = validateDeviceConfig(body.config);
    if (config) return config;
    if (!isChannelFrame(body.light)) return "light frame is missing or incomplete";
    // dark_1 / dark_2 may be missing (flagged as NO_DARK_PAIR), but if present they must be complete.
    for (const key of ["dark_1", "dark_2"]) {
      if (body[key] !== undefined && !isChannelFrame(body[key])) return `${key} frame is incomplete`;
    }
    return null;
  }

  function validateSampleInput(input) {
    const { sample_id, sample_type, known_concentration_nM } = input ?? {};
    if (!sample_id || typeof sample_id !== "string") return "sample_id is required.";
    if (!SAMPLE_TYPES.includes(sample_type)) return `Unknown sample_type: ${sample_type}`;
    if (sample_type === "standard" && !(Number.isFinite(known_concentration_nM) && known_concentration_nM >= 0)) {
      return "A standard needs known_concentration_nM ≥ 0.";
    }
    return null;
  }

  // ---- Processing steps ---------------------------------------------------------

  function darkFrames(reading) {
    return [reading.dark_1, reading.dark_2].filter(isChannelFrame);
  }

  // 1. Dark subtraction: subtract the average of dark_1 and dark_2, clamping negative values to 0.
  //    With only one dark frame, use that one; with neither, skip subtraction (toMeasurement flags NO_DARK_PAIR).
  function subtractDark(reading) {
    const darks = darkFrames(reading);
    const result = {};
    for (const key of DEVICE_CHANNELS) {
      const dark = darks.length ? darks.reduce((sum, frame) => sum + frame[key], 0) / darks.length : 0;
      result[key] = Math.max(0, reading.light[key] - dark);
    }
    return result;
  }

  // 2. Normalize to basic counts: raw / (gain x integration_time_ms)
  function normalize(channels, config) {
    const factor = config.gain * integrationTimeMs(config);
    const result = {};
    for (const [key, value] of Object.entries(channels)) result[key] = value / factor;
    return result;
  }

  // 3. Saturation check: any channel reaching min(65535, (atime + 1) x (astep + 1)).
  function checkSaturation(rawLight, config) {
    const limit = fullScaleCounts(config);
    return DEVICE_CHANNELS.some((key) => rawLight[key] >= limit);
  }

  // What "the signal" means under a basis, as a short id stored on every Measurement, run and
  // curve. A curve only converts readings whose signal id equals its own: if the definition
  // changes later (a ratio, a normalization, a measured unmixing basis), old curves keep saying
  // what they were fitted on and can't silently convert numbers of a different kind.
  function signalId(basis) {
    if (!basis || basis.method !== "single_channel") {
      throw new Error(`Unmixing method "${basis?.method}" isn't implemented.`);
    }
    return String(basis.signal_channel);
  }

  // 4. Unmixing. Only single_channel exists so far: the basis hasn't been calibrated with an
  //    sfGFP standard yet, and least-squares unmixing waits until a measured basis vector
  //    exists — no basis values are invented here.
  function unmix(channels, basis) {
    signalId(basis);
    for (const key of [basis.signal_channel, basis.scatter_channel]) {
      if (!Number.isFinite(channels[key])) throw new Error(`Unmixing basis refers to unknown channel ${key}.`);
    }
    return { fluorescence: channels[basis.signal_channel], scatter: channels[basis.scatter_channel] };
  }

  // Estimated standard deviation of fluorescence (raw counts): read noise only.
  // The difference between the two dark frames estimates a single frame's noise (floored at
  // the quantization error); the variance of light - mean(dark) = sigma^2 (1 + 1/n_dark).
  // Shot noise isn't included — the device gives no information that could estimate it.
  function readNoiseSdCounts(reading, channel) {
    const darks = darkFrames(reading);
    const frameSd = darks.length === 2
      ? Math.max(Math.abs(darks[1][channel] - darks[0][channel]) / Math.SQRT2, QUANTIZATION_SD_COUNTS)
      : QUANTIZATION_SD_COUNTS;
    return frameSd * Math.sqrt(darks.length ? 1 + 1 / darks.length : 1);
  }

  function toContractChannels(channels) {
    const result = {};
    for (const key of DEVICE_CHANNELS) result[CONTRACT_NAME[key] ?? key] = channels[key];
    return result;
  }

  // 5. Assembles the data contract's Measurement.
  //    context.basis         unmixing basis (config/unmix_basis.json)
  //    context.blankScatter  scatter of the most recent blank under the same config, or null
  //    context.timestampUtc  ISO string
  //    STALE_CONFIG needs the run or batch the reading goes into, so it isn't set here.
  function toMeasurement(reading, input, context) {
    // Live-stream data must never become a Measurement (never stored, never added to a plan, never fitted).
    if (!reading || reading.mode !== "measurement") {
      throw new Error(`Only "measurement" readings can become a Measurement (got mode "${reading?.mode}").`);
    }
    const readingError = validateDeviceReading(reading);
    if (readingError) throw new Error(`Invalid device reading: ${readingError}`);
    const inputError = validateSampleInput(input);
    if (inputError) throw new Error(inputError);

    const { basis, blankScatter = null, timestampUtc } = context;
    const { config } = reading;
    const normalized = normalize(subtractDark(reading), config);
    const { fluorescence, scatter } = unmix(normalized, basis);

    const flags = [];
    if (checkSaturation(reading.light, config)) flags.push("SATURATED");
    if (!isChannelFrame(reading.dark_1) || !isChannelFrame(reading.dark_2)) flags.push("NO_DARK_PAIR");
    if (Number.isFinite(blankScatter) && blankScatter > 0 && scatter > HIGH_SCATTER_RATIO * blankScatter) {
      flags.push("HIGH_SCATTER");
    }

    return {
      sample_id: input.sample_id,
      timestamp_utc: timestampUtc,
      sample_type: input.sample_type,
      known_concentration_nM: input.sample_type === "standard" ? input.known_concentration_nM : null,
      signal: signalId(basis),
      fluorescence,
      fluorescence_sd: countsToBasic(readNoiseSdCounts(reading, basis.signal_channel), config),
      scatter,
      flags,
      config_fingerprint: toHardwareConfig(reading).fingerprint,
      raw: toContractChannels(normalized),
      source: "device",
    };
  }

  // Instrument self-check: one read of a buffer-only cuvette, kept as the three frames in integer
  // counts (contract channel names) and never turned into a Measurement. The absolute dark level
  // matters here: a steady light leak raises both darks alike, so their difference can't show it.
  // dark_1 / dark_2 are null when the device didn't return them.
  function toSelfCheck(reading, timestampUtc) {
    if (!reading || reading.mode !== "measurement") {
      throw new Error(`Only "measurement" readings can be self-checked (got mode "${reading?.mode}").`);
    }
    const readingError = validateDeviceReading(reading);
    if (readingError) throw new Error(`Invalid device reading: ${readingError}`);
    const frame = (f) => (isChannelFrame(f) ? toContractChannels(f) : null);
    return {
      timestamp_utc: timestampUtc,
      config: toHardwareConfig(reading),
      dark_1: frame(reading.dark_1),
      light: toContractChannels(reading.light),
      dark_2: frame(reading.dark_2),
    };
  }

  return {
    DEVICE_CHANNELS,
    configFingerprint,
    integrationTimeMs,
    fullScaleCounts,
    countsToBasic,
    readerName,
    toHardwareConfig,
    validateDeviceStatus,
    validateDeviceReading,
    validateSampleInput,
    subtractDark,
    normalize,
    checkSaturation,
    signalId,
    unmix,
    toMeasurement,
    toSelfCheck,
  };
})();
