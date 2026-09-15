// =========================================================
// CAPTURE-Screen 資料處理：裝置原始讀值（POST /read 的回應）-> Measurement。
//
// 全部是純函式：不碰 DOM、不發請求、不讀 localStorage、不讀時鐘（時間由
// 呼叫端傳入）。之後要原封不動移植到 backend/app/hardware/，所以這裡的
// 規則——尤其是 configFingerprint() 的串接格式——前後端必須完全一致。
//
// 真實裝置（live）與模擬裝置（mock）都走這一條：mock 產生的是跟韌體
// 格式相同的讀值，再交給這裡處理，兩種模式的單位與 flag 規則才會一致。
//
// 單位：Measurement 的 fluorescence / scatter / raw 都是
//   basic counts = (light − dark) / (gain × integration_time_ms)
// =========================================================

const HardwareProcessing = (() => {
  const ADC_MAX_COUNTS = 65535;
  const ASTEP_UNIT_MS = 2.78e-3; // 每個 step 2.78 µs
  const DEVICE_CHANNELS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "CLR", "NIR"];
  // 裝置用 CLR；資料契約（Measurement.raw）用 Clear。
  const CONTRACT_NAME = { CLR: "Clear" };
  // ADC 量化誤差的標準差（1 count 的均勻分布）：讀雜訊估計的下限。
  const QUANTIZATION_SD_COUNTS = 1 / Math.sqrt(12);
  const HIGH_SCATTER_RATIO = 2;
  const SAMPLE_TYPES = ["blank", "standard", "unknown"];

  // ---- 組態 -----------------------------------------------------------

  // 固定順序、固定格式：LED 電流取 3 位小數，其餘原樣轉字串，以 "|" 串接，
  // UTF-8 位元組做 FNV-1a 32-bit，取十六進位前 6 碼。
  // 後端必須用一模一樣的規則，否則同一台儀器前後端算出的 fingerprint 會不同。
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

  // GET /status（或 /read）的回應 -> 資料契約的 HardwareConfig。
  function toHardwareConfig(body) {
    const config = {
      fingerprint: "",
      led_current_mA: body.config.led_current_mA,
      gain: body.config.gain,
      atime: body.config.atime,
      astep: body.config.astep,
      build_id: body.build_id,
      firmware_version: body.firmware_version,
      emission_filter: null, // 韌體不知道裝了哪片濾光片；目前也還沒選定
    };
    config.fingerprint = configFingerprint(config);
    return config;
  }

  // ---- 驗證：回傳錯誤訊息字串，沒問題回傳 null ---------------------------

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
    // dark_1 / dark_2 可以缺（會標 NO_DARK_PAIR），但有給就要完整。
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

  // ---- 處理步驟 ---------------------------------------------------------

  function darkFrames(reading) {
    return [reading.dark_1, reading.dark_2].filter(isChannelFrame);
  }

  // 1. 暗值扣除：dark_1 與 dark_2 平均後相減，負值截為 0。
  //    只有一張 dark 就用那一張；兩張都沒有就不扣（並由 toMeasurement 標 NO_DARK_PAIR）。
  function subtractDark(reading) {
    const darks = darkFrames(reading);
    const result = {};
    for (const key of DEVICE_CHANNELS) {
      const dark = darks.length ? darks.reduce((sum, frame) => sum + frame[key], 0) / darks.length : 0;
      result[key] = Math.max(0, reading.light[key] - dark);
    }
    return result;
  }

  // 2. 正規化為 basic counts：raw / (gain × integration_time_ms)
  function normalize(channels, config) {
    const factor = config.gain * integrationTimeMs(config);
    const result = {};
    for (const [key, value] of Object.entries(channels)) result[key] = value / factor;
    return result;
  }

  // 3. 飽和檢查：任一通道達到 min(65535, (atime + 1) × (astep + 1))。
  function checkSaturation(rawLight, config) {
    const limit = fullScaleCounts(config);
    return DEVICE_CHANNELS.some((key) => rawLight[key] >= limit);
  }

  // 4. 解混。目前只有 single_channel：基底尚未以 sfGFP 標準品標定，
  //    最小平方法要等有實測基底向量才實作，這裡不編造基底數值。
  function unmix(channels, basis) {
    if (!basis || basis.method !== "single_channel") {
      throw new Error(`Unmixing method "${basis?.method}" is not implemented.`);
    }
    for (const key of [basis.signal_channel, basis.scatter_channel]) {
      if (!Number.isFinite(channels[key])) throw new Error(`Unmixing basis refers to unknown channel ${key}.`);
    }
    return { fluorescence: channels[basis.signal_channel], scatter: channels[basis.scatter_channel] };
  }

  // fluorescence 的標準差估計（raw counts）：只含讀取雜訊。
  // 兩張 dark 的差估計單張 frame 的雜訊（下限為量化誤差），light − mean(dark)
  // 的變異 = σ² (1 + 1/n_dark)。不含 shot noise——裝置沒有提供可以估它的資訊。
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

  // 5. 組裝成資料契約的 Measurement。
  //    context.basis         解混基底（config/unmix_basis.json）
  //    context.blankScatter  同組態最近一次 blank 的 scatter，沒有就 null
  //    context.timestampUtc  ISO 字串
  //    需要儲存狀態才能判斷的 flag（STALE_CONFIG、BELOW_LOD、ABOVE_RANGE）不在這裡。
  function toMeasurement(reading, input, context) {
    // 即時串流的資料一律不得變成 Measurement（不存、不進 plan、不擬合）。
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
    };
  }

  // 暗讀檢查：兩張 dark 相減（保留正負號），正常應該每個通道都在 0 附近。
  // 裝置沒有「只讀暗值」的端點，所以用同一次 POST /read 的 dark_1 / dark_2。
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
