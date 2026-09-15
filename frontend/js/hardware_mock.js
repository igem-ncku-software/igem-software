// =========================================================
// CAPTURE-Screen 模擬裝置（DEVICE_MODE = "mock"）。
//
// 模擬的是韌體本身：產生跟 firmware/as7341 一模一樣格式的 GET /status 與
// POST /read 回應（dark_1 / light / dark_2 的原始 ADC counts），再交給
// js/hardware_processing.js 處理成 Measurement。所以 mock 與 live 走的是同一條
// 暗值扣除、正規化、解混與 flag 規則，單位也一致。
//
// 讀值由 4PL 真值模型正推（raw counts @ gain 16），套上 3% 比例噪音 + 8 counts
// 加成噪音，再依螢光值分配到各通道。沒有手寫的隨機數字或裝飾用的 flag。
//
// 儲存與擬合不在這裡，在 js/hardware_local.js（mock 與 live 共用）。
// 頁面一律不直接呼叫這支，只透過 js/hardware_api.js；唯一例外是
// js/hardware_mock_panel.js 的 mock 控制面板。沒有硬體時仍要能完整展示流程，
// 所以接上真實裝置後也不要刪除這支。
// =========================================================

// ---- 模型真值與模擬參數（只存在 mock 裡，頁面拿不到） ----------------

const MOCK_TRUTH = { top: 2710, bottom: 198, ec50_nM: 118, hill: 1.06 }; // raw counts @ gain 16
const MOCK_NOISE_PROPORTIONAL = 0.03;
const MOCK_NOISE_ADDITIVE_COUNTS = 8;

// 以下 counts 都是 gain 16 時的值，換 gain 時等比例縮放。
const MOCK_BASE_GAIN = 16;
const MOCK_F3_LEAKAGE_COUNTS = 600;  // 480 nm 激發光漏光，與濃度無關；single_channel 解混把它當 scatter
const MOCK_F4_BACKGROUND_COUNTS = 20;
const MOCK_F5_RATIO = 0.6;           // 555 nm 約為 515 nm 的 60%
const MOCK_CHANNEL_BACKGROUND = { F1: 14, F2: 22, F5: 16, F6: 18, F7: 12, F8: 9, CLR: 30, NIR: 7 };
const MOCK_CHANNEL_READ_NOISE = 2;
const MOCK_DARK_OFFSET_COUNTS = 1;   // LED 關閉時的暗電流
const MOCK_DARK_NOISE_COUNTS = 0.6;

// 約 10% 的讀值有氣泡 / 刮痕造成的額外散射，打在 F3 上。
const MOCK_HIGH_SCATTER_PROBABILITY = 0.10;

// 沒有指定濃度時，unknown 樣品的真值在這個區間內 log-uniform 抽樣。
const MOCK_UNKNOWN_RANGE_NM = [3, 1000];

const MOCK_DEVICE = {
  device_id: "capture-screen-mock",
  build_id: "P1-PROTO-01",
  // 跟真實韌體（0.2.0）不同，mock 建的曲線因此永遠不會被當成真實裝置可用的曲線。
  firmware_version: "0.2.0-mock",
  led_current_mA: 5.553,
  atime: 29,
  astep: 599,
};

const MOCK_SIM_KEY = "lasreader.hardware.mockDevice.v1";

// ---- 模擬開關（由 mock 控制面板改） ------------------------------------
//   gain           回報的倍率；換 gain 就換 config fingerprint
//   offline        模擬裝置連不上
//   drop_dark      回應缺 dark_2（NO_DARK_PAIR）
//   unknown_nM     unknown 樣品的真實濃度（null = 隨機抽）
//   unknown_signal 直接指定 unknown 的期望 F4 訊號（raw counts @ gain 16），
//                  用來測極低 / 極高訊號的邊界顯示；有值時優先於 unknown_nM

function mockDefaultSim() {
  return { gain: MOCK_BASE_GAIN, offline: false, drop_dark: false, unknown_nM: null, unknown_signal: null };
}

let mockMemorySim = null;

function mockLoadSim() {
  try {
    const raw = localStorage.getItem(MOCK_SIM_KEY);
    if (raw) return { ...mockDefaultSim(), ...JSON.parse(raw) };
  } catch (err) {
    // localStorage 不能用：退回記憶體。
  }
  return mockMemorySim ?? mockDefaultSim();
}

function mockSaveSim(sim) {
  mockMemorySim = sim;
  try {
    localStorage.setItem(MOCK_SIM_KEY, JSON.stringify(sim));
  } catch (err) {
    // 同上。
  }
}

// ---- 模擬韌體 ----------------------------------------------------------

const mockBootMs = Date.now();

function mockGauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mockTruthSignal(c) {
  if (c <= 0) return MOCK_TRUTH.bottom;
  return MOCK_TRUTH.bottom + (MOCK_TRUTH.top - MOCK_TRUTH.bottom) / (1 + (MOCK_TRUTH.ec50_nM / c) ** MOCK_TRUTH.hill);
}

function mockRequireOnline(sim) {
  if (sim.offline) throw new Error(`Device not reachable at ${DEVICE_BASE_URL} (simulated offline)`);
}

function mockDeviceConfig(sim) {
  return {
    led_current_mA: MOCK_DEVICE.led_current_mA,
    gain: sim.gain,
    atime: MOCK_DEVICE.atime,
    astep: MOCK_DEVICE.astep,
  };
}

// GET /status 的回應格式
function mockStatusBody(sim) {
  return {
    device_id: MOCK_DEVICE.device_id,
    build_id: MOCK_DEVICE.build_id,
    firmware_version: MOCK_DEVICE.firmware_version,
    state: "IDLE",
    uptime_ms: Date.now() - mockBootMs,
    wifi_rssi: -55,
    config: mockDeviceConfig(sim),
  };
}

// POST /read 的回應格式：三組原始 ADC counts，裝置端不做任何運算。
function mockReadBody(sim, { trueConcentration, expectedSignal }) {
  const config = mockDeviceConfig(sim);
  const scale = sim.gain / MOCK_BASE_GAIN;
  // ADC 在 min(65535, (ATIME+1)(ASTEP+1)) 飽和；超過就被截在上限。
  const fullScale = HardwareProcessing.fullScaleCounts(config);
  const adc = (value) => Math.min(fullScale, Math.max(0, Math.round(value)));

  const darkFrame = () => {
    const frame = {};
    for (const key of HardwareProcessing.DEVICE_CHANNELS) {
      frame[key] = adc(MOCK_DARK_OFFSET_COUNTS + MOCK_DARK_NOISE_COUNTS * mockGauss());
    }
    return frame;
  };

  const expected = (expectedSignal ?? mockTruthSignal(trueConcentration)) * scale;
  const signal = expected * (1 + MOCK_NOISE_PROPORTIONAL * mockGauss())
    + MOCK_NOISE_ADDITIVE_COUNTS * scale * mockGauss();
  const lit = (value) => adc(value + MOCK_DARK_OFFSET_COUNTS + MOCK_CHANNEL_READ_NOISE * scale * mockGauss());

  let leakage = MOCK_F3_LEAKAGE_COUNTS * scale * (1 + 0.01 * mockGauss());
  if (Math.random() < MOCK_HIGH_SCATTER_PROBABILITY) leakage += MOCK_F3_LEAKAGE_COUNTS * scale * (1.5 + Math.random());

  const light = {};
  for (const key of HardwareProcessing.DEVICE_CHANNELS) light[key] = lit((MOCK_CHANNEL_BACKGROUND[key] ?? 0) * scale);
  light.F3 = lit(leakage);
  light.F4 = lit(signal + MOCK_F4_BACKGROUND_COUNTS * scale);
  light.F5 = lit(MOCK_F5_RATIO * signal + MOCK_CHANNEL_BACKGROUND.F5 * scale);

  const body = {
    mode: "measurement",
    device_id: MOCK_DEVICE.device_id,
    build_id: MOCK_DEVICE.build_id,
    firmware_version: MOCK_DEVICE.firmware_version,
    uptime_ms: Date.now() - mockBootMs,
    read_time_ms: Math.round(440 + 30 * Math.random()),
    config,
    dark_1: darkFrame(),
    light,
    dark_2: darkFrame(),
    clear_nir_mode2: { CLR: lit(MOCK_CHANNEL_BACKGROUND.CLR * scale), NIR: lit(MOCK_CHANNEL_BACKGROUND.NIR * scale) },
  };
  if (sim.drop_dark) delete body.dark_2;
  return body;
}

// ---- 對 hardware_api.js 公開（形狀與真實裝置走 HardwareApi 後相同） ------

const HardwareMock = {
  deviceStatus() {
    const sim = mockLoadSim();
    mockRequireOnline(sim);
    return {
      online: true,
      last_seen: new Date().toISOString(),
      config: HardwareProcessing.toHardwareConfig(mockStatusBody(sim)),
    };
  },

  darkRead() {
    const sim = mockLoadSim();
    mockRequireOnline(sim);
    const reading = mockReadBody(sim, { trueConcentration: 0, expectedSignal: null });
    return HardwareProcessing.toDarkCheckMeasurement(reading, `DARK-${Date.now()}`, new Date().toISOString());
  },

  readSample(input, basis) {
    const sim = mockLoadSim();
    mockRequireOnline(sim);
    const inputError = HardwareProcessing.validateSampleInput(input);
    if (inputError) throw new Error(inputError);

    let trueConcentration = 0;
    let expectedSignal = null;
    if (input.sample_type === "unknown" && sim.unknown_signal !== null) {
      expectedSignal = sim.unknown_signal;
    } else if (input.sample_type === "standard") {
      trueConcentration = input.known_concentration_nM;
    } else if (input.sample_type === "unknown") {
      const [lo, hi] = MOCK_UNKNOWN_RANGE_NM;
      trueConcentration = sim.unknown_nM ?? Math.exp(Math.log(lo) + Math.random() * Math.log(hi / lo));
    }

    const reading = mockReadBody(sim, { trueConcentration, expectedSignal });
    const fingerprint = HardwareProcessing.toHardwareConfig(reading).fingerprint;
    const m = HardwareProcessing.toMeasurement(reading, input, {
      basis,
      blankScatter: HardwareLocal.measurementContext(fingerprint).blankScatter,
      timestampUtc: new Date().toISOString(),
    });
    return HardwareLocal.finalizeMeasurement(m);
  },

  // ---- 只給 mock 控制面板用 ----
  getSim() {
    return { ...mockLoadSim() };
  },

  setSim(patch) {
    const sim = { ...mockLoadSim(), ...patch };
    mockSaveSim(sim);
    return { ...sim };
  },

  // 清掉模擬開關，以及儲存端的所有 plan / curve。
  reset() {
    mockMemorySim = null;
    try {
      localStorage.removeItem(MOCK_SIM_KEY);
    } catch (err) {
      // 沒有 localStorage 就只清記憶體。
    }
    HardwareLocal.reset();
  },
};
