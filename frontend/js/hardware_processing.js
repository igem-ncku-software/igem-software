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
  // would compute different fingerprints.
  function configFingerprint(config) {
    const canonical = [
      Number(config.led_current_mA).toFixed(3),
      String(config.gain),
      String(config.atime),
      String(config.astep),
      String(config.build_id),
      String(config.firmware_version),
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
      firmware_version: body.firmware_version,
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
    if (!Number.isFinite(config.led_current_mA)) return "config.led_current_mA is not a number";
    if (!(Number.isFinite(config.gain) && config.gain > 0)) return "config.gain must be a positive number";
    if (!(Number.isInteger(config.atime) && config.atime >= 0)) return "config.atime must be a non-negative integer";
    if (!(Number.isInteger(config.astep) && config.astep >= 0)) return "config.astep must be a non-negative integer";
    return null;
  }

  function validateIdentity(body) {
    if (typeof body.build_id !== "string") return "build_id is missing";
    if (typeof body.firmware_version !== "string") return "firmware_version is missing";
    return null;
  }

  function validateDeviceStatus(body) {
    if (!body || typeof body !== "object") return "response is not a JSON object";
    if (typeof body.device_id !== "string") return "device_id is missing";
    const identity = validateIdentity(body);
    if (identity) return identity;
    if (!["IDLE", "LIVE", "MEASURING"].includes(body.state)) return `unknown state ${body.state}`;
    return validateDeviceConfig(body.config);
  }

  function validateDeviceReading(body) {
    if (!body || typeof body !== "object") return "response is not a JSON object";
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

  // 4. Unmixing. Only single_channel exists so far: the basis hasn't been calibrated with an
  //    sfGFP standard yet, and least-squares unmixing waits until a measured basis vector
  //    exists — no basis values are invented here.
  function unmix(channels, basis) {
    if (!basis || basis.method !== "single_channel") {
      throw new Error(`Unmixing method "${basis?.method}" is not implemented.`);
    }
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
  //    Flags that need stored state to determine (STALE_CONFIG, BELOW_LOD, ABOVE_RANGE) aren't set here.
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
      fluorescence,
      fluorescence_sd: countsToBasic(readNoiseSdCounts(reading, basis.signal_channel), config),
      scatter,
      flags,
      config_fingerprint: toHardwareConfig(reading).fingerprint,
      raw: toContractChannels(normalized),
      source: "device",
    };
  }

  // Dark-read check: subtracts the two dark frames (sign preserved); normally every channel should sit near 0.
  // The device has no "dark-only" endpoint, so this reuses the dark_1 / dark_2 from one POST /read call.
  function toDarkCheckMeasurement(reading, sampleId, timestampUtc) {
    if (!reading || reading.mode !== "measurement") {
      throw new Error(`Only "measurement" readings can be dark-checked (got mode "${reading?.mode}").`);
    }
    const readingError = validateDeviceReading(reading);
    if (readingError) throw new Error(`Invalid device reading: ${readingError}`);

    const { config } = reading;
    const paired = isChannelFrame(reading.dark_1) && isChannelFrame(reading.dark_2);
    const diff = {};
    for (const key of DEVICE_CHANNELS) diff[key] = paired ? reading.dark_2[key] - reading.dark_1[key] : NaN;
    const normalized = normalize(diff, config);

    return {
      sample_id: sampleId,
      timestamp_utc: timestampUtc,
      sample_type: "blank",
      known_concentration_nM: null,
      fluorescence: normalized.F4,
      fluorescence_sd: countsToBasic(QUANTIZATION_SD_COUNTS * Math.SQRT2, config),
      scatter: normalized.F3,
      flags: paired ? [] : ["NO_DARK_PAIR"],
      config_fingerprint: toHardwareConfig(reading).fingerprint,
      raw: toContractChannels(normalized),
      source: "device",
    };
  }

  return {
    DEVICE_CHANNELS,
    configFingerprint,
    integrationTimeMs,
    fullScaleCounts,
    countsToBasic,
    toHardwareConfig,
    validateDeviceStatus,
    validateDeviceReading,
    validateSampleInput,
    subtractDark,
    normalize,
    checkSaturation,
    unmix,
    toMeasurement,
    toDarkCheckMeasurement,
  };
})();
