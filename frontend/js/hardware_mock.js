// =========================================================
// CAPTURE-Screen 的假資料來源。這次前端還沒有接後端，這支暫時扮演整個後端：
//
//   1. 模擬儀器：用 4PL 真值模型正推 sfGFP 螢光，套上 3% 比例噪音 + 8 counts
//      加成噪音，再依螢光值分配到 AS7341 各通道。raw、scatter、flags 全部
//      從同一次模擬算出來，沒有任何手寫的隨機數字或裝飾用的 flag。
//   2. 模擬後端：calibration plan / curve 的存取、4PL 加權擬合（Levenberg–
//      Marquardt）、LOD/LOQ、濃度反推與 95% CI（delta method）。
//
// 五個頁面是各自獨立的 HTML，狀態必須跨頁面保留，所以存在 localStorage
// （讀寫失敗時退回記憶體，重新整理就會清空）。
//
// 頁面一律不直接呼叫這支，只透過 js/hardware_api.js。唯一例外是
// js/hardware_mock_panel.js 的 mock 控制面板；接上真後端時這兩支一起拿掉。
// =========================================================

// ---- 模型真值與模擬參數（只存在 mock 裡，頁面拿不到） ----------------

const MOCK_TRUTH = { top: 2710, bottom: 198, ec50_nM: 118, hill: 1.06 };
const MOCK_NOISE_PROPORTIONAL = 0.03;
const MOCK_NOISE_ADDITIVE_COUNTS = 8;

// 以下 counts 都是 gain 16 時的值，換 gain 時等比例縮放。
const MOCK_BASE_GAIN = 16;
const MOCK_F3_LEAKAGE_COUNTS = 600;  // 480 nm 激發光漏光，與濃度無關
const MOCK_F4_BACKGROUND_COUNTS = 20; // 解混時從 F4 扣掉的背景
const MOCK_F5_RATIO = 0.6;            // 555 nm 約為 515 nm 的 60%
const MOCK_CHANNEL_BACKGROUND = { F1: 14, F2: 22, F5: 16, F6: 18, F7: 12, F8: 9, Clear: 30, NIR: 7 };
const MOCK_CHANNEL_READ_NOISE = 2;

const MOCK_SATURATION_COUNTS = 65535;
const MOCK_SCATTER_BASE = 45;
const MOCK_SCATTER_JITTER = 4;
const MOCK_HIGH_SCATTER_PROBABILITY = 0.10;
const MOCK_HIGH_SCATTER_THRESHOLD = 120;

// 沒有指定濃度時，unknown 樣品的真值在這個區間內 log-uniform 抽樣。
const MOCK_UNKNOWN_RANGE_NM = [3, 1000];

// 反推範圍的上限：4PL 到達 95% span 之後太平，反推誤差會爆掉。
const MOCK_RANGE_SPAN_FRACTION = 0.95;

const MOCK_CHANNELS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "Clear", "NIR"];
const MOCK_STORE_KEY = "lasreader.hardware.mock.v1";

// ---- 狀態儲存 --------------------------------------------------------

function mockDefaultStore() {
  return {
    plans: {},         // plan_id -> CalibrationPlan
    drafts: {},        // curve_id -> { curve, cov, noise }：已擬合、尚未存檔
    curves: {},        // curve_id -> CalibrationCurve：已存檔
    curve_private: {}, // curve_id -> { cov, noise }：反推 CI 需要，但不在資料契約裡
    // 模擬用的開關，由 mock 控制面板改。
    //   unknown_nM     unknown 樣品的真實濃度（null = 隨機抽）
    //   unknown_signal 直接指定 unknown 的期望螢光（counts @ gain 16），用來測
    //                  極低 / 極高訊號的邊界顯示；有值時優先於 unknown_nM
    sim: { gain: MOCK_BASE_GAIN, offline: false, drop_dark: false, unknown_nM: null, unknown_signal: null },
  };
}

let mockMemoryStore = null;

function mockLoad() {
  try {
    const raw = localStorage.getItem(MOCK_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const base = mockDefaultStore();
      return { ...base, ...parsed, sim: { ...base.sim, ...parsed.sim } };
    }
  } catch (err) {
    // localStorage 被停用或內容壞掉：退回記憶體。
  }
  return mockMemoryStore ?? mockDefaultStore();
}

function mockSave(store) {
  mockMemoryStore = store;
  try {
    localStorage.setItem(MOCK_STORE_KEY, JSON.stringify(store));
  } catch (err) {
    // 同上，記憶體裡那份還在。
  }
}

// ---- 小工具 ----------------------------------------------------------

function mockGauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mockId(prefix) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return `${prefix}-${date}-${suffix}`;
}

function mockFail(message) {
  throw new Error(message);
}

// plan 裡 label 用的濃度字串；超過 1000 nM 改寫成 µM，跟頁面的顯示規則一致。
function mockConcentrationLabel(nM) {
  return nM > 1000 ? `${+(nM / 1000).toFixed(3)} µM` : `${+nM.toFixed(3)} nM`;
}

function mockMean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function mockSampleSd(values) {
  if (values.length < 2) return 0;
  const m = mockMean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

// ---- 儀器組態 --------------------------------------------------------

// FNV-1a，取前 6 碼當短 fingerprint。任何組態欄位變動都會換一個值。
function mockFingerprint(config) {
  const text = JSON.stringify([
    config.led_current_mA, config.gain, config.atime, config.astep,
    config.build_id, config.firmware_version, config.emission_filter,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

function mockConfig(store) {
  const config = {
    fingerprint: "",
    led_current_mA: 5.553,
    gain: store.sim.gain,
    atime: 29,
    astep: 599,
    build_id: "P1-PROTO-01",
    firmware_version: "mock-0.1.0",
    emission_filter: null,
  };
  config.fingerprint = mockFingerprint(config);
  return config;
}

// ---- 4PL -------------------------------------------------------------

// 擬合時的參數向量是 [top, bottom, ln(ec50_nM), hill]：用 ln(EC50) 讓 LM 在
// 對數尺度上走，EC50 也不會被推成負數。
function mockModel(c, p) {
  if (c <= 0) return p[1];
  const u = Math.exp(p[3] * (p[2] - Math.log(c)));
  return p[1] + (p[0] - p[1]) / (1 + u);
}

function mockGradient(c, p) {
  if (c <= 0) return [0, 1, 0, 0];
  const lnRatio = p[2] - Math.log(c);
  const s = 1 / (1 + Math.exp(p[3] * lnRatio)); // u 溢位成 Infinity 時 s = 0，仍然安全
  const span = p[0] - p[1];
  const ds = s * (1 - s); // = u / (1 + u)^2，數值上比直接算穩定
  return [s, 1 - s, -span * ds * p[3], -span * ds * lnRatio];
}

function mockTruthSignal(c) {
  const p = [MOCK_TRUTH.top, MOCK_TRUTH.bottom, Math.log(MOCK_TRUTH.ec50_nM), MOCK_TRUTH.hill];
  return mockModel(c, p);
}

// ---- 線性代數（4x4 就夠） ---------------------------------------------

function mockSolve(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-300) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let k = col; k <= n; k++) a[r][k] -= f * a[col][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

function mockInverse(matrix) {
  const n = matrix.length;
  const columns = [];
  for (let j = 0; j < n; j++) {
    const e = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
    const col = mockSolve(matrix, e);
    if (!col) return null;
    columns.push(col);
  }
  return Array.from({ length: n }, (_, i) => columns.map((col) => col[i]));
}

// ---- 擬合 ------------------------------------------------------------

function mockGroupByConcentration(points) {
  const groups = new Map();
  for (const pt of points) {
    if (!groups.has(pt.c)) groups.set(pt.c, []);
    groups.get(pt.c).push(pt.y);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([c, ys]) => ({ c, ys, mean: mockMean(ys) }));
}

// 加權最小平方，權重 = 1 / fluorescence_sd²（每管自己回報的估計標準差）。
function mockFit4PL(points) {
  const groups = mockGroupByConcentration(points);
  const bottom0 = groups[0].mean;
  let top0 = groups[groups.length - 1].mean;
  if (top0 <= bottom0) top0 = bottom0 + 1;
  const mid = (top0 + bottom0) / 2;
  const nonzero = groups.filter((g) => g.c > 0);
  const nearest = nonzero.reduce((best, g) => (Math.abs(g.mean - mid) < Math.abs(best.mean - mid) ? g : best));
  let p = [top0, bottom0, Math.log(nearest.c), 1];

  const cost = (q) => points.reduce((acc, pt) => acc + ((pt.y - mockModel(pt.c, q)) / pt.sd) ** 2, 0);

  const normalEquations = (q) => {
    const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const g = [0, 0, 0, 0];
    for (const pt of points) {
      const w = 1 / (pt.sd * pt.sd);
      const r = pt.y - mockModel(pt.c, q);
      const J = mockGradient(pt.c, q);
      for (let i = 0; i < 4; i++) {
        g[i] += w * J[i] * r;
        for (let j = 0; j < 4; j++) A[i][j] += w * J[i] * J[j];
      }
    }
    return { A, g };
  };

  let current = cost(p);
  let lambda = 1e-2;
  for (let iter = 0; iter < 500; iter++) {
    const { A, g } = normalEquations(p);
    let accepted = false;
    let converged = false;
    while (lambda < 1e12) {
      const damped = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const step = mockSolve(damped, g);
      if (step) {
        const trial = p.map((v, i) => v + step[i]);
        if (trial[3] > 0.05 && trial[3] < 20) {
          const trialCost = cost(trial);
          if (trialCost < current) {
            converged = (current - trialCost) / Math.max(current, 1e-12) < 1e-10;
            p = trial;
            current = trialCost;
            lambda = Math.max(lambda / 10, 1e-12);
            accepted = true;
            break;
          }
        }
      }
      lambda *= 10;
    }
    if (!accepted || converged) break;
  }

  // 參數共變異 = (JᵀWJ)⁻¹ · reduced χ²
  const { A } = normalEquations(p);
  const inv = mockInverse(A);
  const dof = points.length - 4;
  const scale = dof > 0 ? current / dof : NaN;
  const cov = inv ? inv.map((row) => row.map((v) => v * scale)) : null;
  return { p, cov };
}

// 未知樣品單次讀值的變異數模型 var(F) = a + b·F²，從校正資料的重複管估出來
// （對應比例 + 加成噪音），不直接拿生成器的真值。
function mockNoiseModel(points) {
  const groups = mockGroupByConcentration(points).filter((g) => g.ys.length >= 2);
  if (groups.length === 0) {
    return { a: mockMean(points.map((pt) => pt.sd * pt.sd)), b: 0 };
  }
  const xs = groups.map((g) => g.mean * g.mean);
  const vs = groups.map((g) => mockSampleSd(g.ys) ** 2);
  const n = groups.length;
  const sx = xs.reduce((s, x) => s + x, 0);
  const sxx = xs.reduce((s, x) => s + x * x, 0);
  const sv = vs.reduce((s, v) => s + v, 0);
  const sxv = xs.reduce((s, x, i) => s + x * vs[i], 0);
  const det = n * sxx - sx * sx;
  let a = det > 0 ? (sxx * sv - sx * sxv) / det : -1;
  let b = det > 0 ? (n * sxv - sx * sv) / det : -1;
  if (b < 0 || det <= 0) {
    b = 0;
    a = sv / n;
  } else if (a < 0) {
    a = 0;
    b = sxv / sxx;
  }
  return { a, b };
}

// 螢光 -> 濃度。只在曲線可信範圍內給點估計，範圍外只回 status，不外插。
function mockInverseCore(F, curve, priv) {
  const { top, bottom, ec50_nM, hill } = curve.params;
  if (!(F > bottom)) return { status: "below_lod" };
  if (!(F < top)) return { status: "above_range" };

  const lnRatio = Math.log((F - bottom) / (top - F));
  const lnC = Math.log(ec50_nM) + lnRatio / hill;
  const c = Math.exp(lnC);
  if (c < curve.range_nM.min) return { status: "below_lod" };
  if (c > curve.range_nM.max) return { status: "above_range" };

  // delta method on ln(c)：讀值本身的變異 + 參數共變異
  const gF = (1 / hill) * (1 / (F - bottom) + 1 / (top - F));
  const gTheta = [-(1 / hill) / (top - F), -(1 / hill) / (F - bottom), 1, -lnRatio / (hill * hill)];
  let variance = gF * gF * (priv.noise.a + priv.noise.b * F * F);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) variance += gTheta[i] * priv.cov[i][j] * gTheta[j];
  }
  const half = 1.96 * Math.sqrt(Math.max(variance, 0));
  return { status: "ok", concentration_nM: c, ci95_nM: [Math.exp(lnC - half), Math.exp(lnC + half)] };
}

function mockActiveCurve(store) {
  return Object.values(store.curves).find((c) => c.is_active) ?? null;
}

// ---- 模擬讀值 --------------------------------------------------------

// expectedSignal（counts @ gain 16）給了就跳過 4PL 正推，只給 mock 面板的
// 極低 / 極高訊號測試用；噪音、通道分配、flags 照常套用。
function mockSimulateMeasurement(store, { sample_id, sample_type, trueConcentration, known_concentration_nM, expectedSignal }) {
  const config = mockConfig(store);
  const scale = config.gain / MOCK_BASE_GAIN;
  const flags = [];

  const expected = (expectedSignal ?? mockTruthSignal(trueConcentration)) * scale;
  const signal = expected * (1 + MOCK_NOISE_PROPORTIONAL * mockGauss())
    + MOCK_NOISE_ADDITIVE_COUNTS * scale * mockGauss();

  const channel = (value) => Math.round(value + MOCK_CHANNEL_READ_NOISE * scale * mockGauss());
  const raw = {};
  for (const key of MOCK_CHANNELS) raw[key] = channel((MOCK_CHANNEL_BACKGROUND[key] ?? 0) * scale);
  raw.F3 = channel(MOCK_F3_LEAKAGE_COUNTS * scale);
  raw.F4 = channel(signal + MOCK_F4_BACKGROUND_COUNTS * scale);
  raw.F5 = channel(MOCK_F5_RATIO * signal + MOCK_CHANNEL_BACKGROUND.F5 * scale);

  // ADC 只有 16 bit：超過就截斷，並標 SATURATED。
  for (const key of MOCK_CHANNELS) {
    if (raw[key] > MOCK_SATURATION_COUNTS) {
      raw[key] = MOCK_SATURATION_COUNTS;
      if (!flags.includes("SATURATED")) flags.push("SATURATED");
    }
  }

  // 解混後的 sfGFP 訊號由（可能被截斷的）F4 算回來，截斷會如實反映在數字上。
  const fluorescence = raw.F4 - MOCK_F4_BACKGROUND_COUNTS * scale;
  const fluorescence_sd = Math.sqrt(
    (MOCK_NOISE_PROPORTIONAL * Math.max(fluorescence, 0)) ** 2 + (MOCK_NOISE_ADDITIVE_COUNTS * scale) ** 2,
  );

  const scatterEvent = Math.random() < MOCK_HIGH_SCATTER_PROBABILITY;
  let scatter = (MOCK_SCATTER_BASE + MOCK_SCATTER_JITTER * mockGauss()) * scale;
  if (scatterEvent) scatter *= 3.5 + Math.random();
  if (scatter > MOCK_HIGH_SCATTER_THRESHOLD * scale) flags.push("HIGH_SCATTER");

  if (store.sim.drop_dark) flags.push("NO_DARK_PAIR");

  return {
    sample_id,
    timestamp_utc: new Date().toISOString(),
    sample_type,
    known_concentration_nM: sample_type === "standard" ? known_concentration_nM : null,
    fluorescence,
    fluorescence_sd,
    scatter: Math.round(scatter * 10) / 10,
    flags,
    config_fingerprint: config.fingerprint,
    raw,
  };
}

function mockRequireOnline(store) {
  if (store.sim.offline) mockFail("Device offline: no response from CAPTURE-Screen.");
}

// ---- 對 hardware_api.js 公開的「後端」 -------------------------------

const HardwareMock = {
  deviceStatus() {
    const store = mockLoad();
    const lagMs = store.sim.offline ? 5 * 60 * 1000 : 1000 + Math.random() * 2000;
    return {
      online: !store.sim.offline,
      last_seen: new Date(Date.now() - lagMs).toISOString(),
      config: mockConfig(store),
    };
  },

  // 暗讀：LED 關閉時的 dark frame 扣掉前一張 dark frame，正常應該每個通道都是 0
  // 附近（只剩讀取噪音）。資料契約沒有 "dark" 這種 sample_type，所以用 blank。
  darkRead() {
    const store = mockLoad();
    mockRequireOnline(store);
    const config = mockConfig(store);
    const raw = {};
    for (const key of MOCK_CHANNELS) raw[key] = Math.round(0.6 * mockGauss());
    return {
      sample_id: `DARK-${Date.now()}`,
      timestamp_utc: new Date().toISOString(),
      sample_type: "blank",
      known_concentration_nM: null,
      fluorescence: raw.F4,
      fluorescence_sd: 0.6,
      scatter: raw.NIR,
      flags: [],
      config_fingerprint: config.fingerprint,
      raw,
    };
  },

  readSample(input) {
    const store = mockLoad();
    mockRequireOnline(store);
    const { sample_id, sample_type, known_concentration_nM } = input ?? {};
    if (!sample_id || typeof sample_id !== "string") mockFail("sample_id is required.");
    if (!["blank", "standard", "unknown"].includes(sample_type)) mockFail(`Unknown sample_type: ${sample_type}`);

    let trueConcentration = 0;
    let expectedSignal = null;
    if (sample_type === "unknown" && store.sim.unknown_signal !== null) {
      expectedSignal = store.sim.unknown_signal;
    } else if (sample_type === "standard") {
      if (!(Number.isFinite(known_concentration_nM) && known_concentration_nM >= 0)) {
        mockFail("A standard needs known_concentration_nM ≥ 0.");
      }
      trueConcentration = known_concentration_nM;
    } else if (sample_type === "unknown") {
      const [lo, hi] = MOCK_UNKNOWN_RANGE_NM;
      trueConcentration = store.sim.unknown_nM ?? Math.exp(Math.log(lo) + Math.random() * Math.log(hi / lo));
    }

    const m = mockSimulateMeasurement(store, { sample_id, sample_type, trueConcentration, known_concentration_nM, expectedSignal });

    // unknown 的 QC：跟 active 曲線比，規則和 invert() 完全一樣。
    const active = mockActiveCurve(store);
    if (sample_type === "unknown" && active) {
      if (active.config_fingerprint !== m.config_fingerprint) {
        m.flags.push("STALE_CONFIG");
      } else {
        const { status } = mockInverseCore(m.fluorescence, active, store.curve_private[active.curve_id]);
        if (status === "below_lod") m.flags.push("BELOW_LOD");
        if (status === "above_range") m.flags.push("ABOVE_RANGE");
      }
    }
    return m;
  },

  createCalibrationPlan(input) {
    const store = mockLoad();
    const { concentrations_nM, replicates, blanks, timepoint } = input ?? {};
    if (!Array.isArray(concentrations_nM) || concentrations_nM.length === 0) mockFail("Enter at least one concentration.");
    if (!concentrations_nM.every((c) => Number.isFinite(c) && c > 0)) mockFail("Concentrations must be positive numbers.");
    const concentrations = [...new Set(concentrations_nM)].sort((a, b) => a - b);
    if (concentrations.length < 4) mockFail("A 4PL fit needs at least 4 distinct concentrations.");
    if (!(Number.isInteger(replicates) && replicates >= 1 && replicates <= 10)) mockFail("Replicates must be an integer from 1 to 10.");
    if (!(Number.isInteger(blanks) && blanks >= 2 && blanks <= 10)) mockFail("Blanks must be an integer from 2 to 10 (LOD needs a blank SD).");
    if (!timepoint || !String(timepoint).trim()) mockFail("Describe the timepoint.");

    // 以「重複輪」交錯排列：每一輪先 blank，再濃度由低到高。這樣儀器漂移不會
    // 集中在某個濃度上，單支 cuvette 從低濃度換到高濃度也比較不怕殘留。
    const items = [];
    const rounds = Math.max(replicates, blanks);
    for (let r = 1; r <= rounds; r++) {
      if (r <= blanks) items.push({ label: `blank r${r}`, sample_type: "blank", concentration_nM: null });
      if (r <= replicates) {
        for (const c of concentrations) {
          items.push({ label: `${mockConcentrationLabel(c)} r${r}`, sample_type: "standard", concentration_nM: c });
        }
      }
    }

    const plan = {
      plan_id: mockId("PLAN"),
      created_at: new Date().toISOString(),
      config_fingerprint: mockConfig(store).fingerprint,
      timepoint: String(timepoint).trim(),
      items: items.map((item, i) => ({ slot: i + 1, ...item, measurement: null })),
    };
    store.plans[plan.plan_id] = plan;
    mockSave(store);
    return plan;
  },

  getCalibrationPlan(plan_id) {
    const plan = mockLoad().plans[plan_id];
    if (!plan) mockFail(`Plan ${plan_id} not found.`);
    return plan;
  },

  recordPlanMeasurement(plan_id, slot, m) {
    const store = mockLoad();
    const plan = store.plans[plan_id];
    if (!plan) mockFail(`Plan ${plan_id} not found.`);
    const item = plan.items.find((it) => it.slot === slot);
    if (!item) mockFail(`Slot ${slot} does not exist in ${plan_id}.`);

    // 單支 cuvette 必須照順序跑：只能量「下一管」，或重測已經量過的管。
    const next = plan.items.find((it) => it.measurement === null);
    if (item.measurement === null && next && next.slot !== slot) {
      mockFail(`Slot ${slot} is out of order; the next tube is slot ${next.slot}.`);
    }
    if (!m || m.sample_type !== item.sample_type) mockFail(`Slot ${slot} expects a ${item.sample_type} measurement.`);
    if (item.sample_type === "standard" && m.known_concentration_nM !== item.concentration_nM) {
      mockFail(`Slot ${slot} expects ${item.concentration_nM} nM.`);
    }

    const recorded = { ...m, flags: [...m.flags] };
    if (recorded.config_fingerprint !== plan.config_fingerprint && !recorded.flags.includes("STALE_CONFIG")) {
      recorded.flags.push("STALE_CONFIG");
    }
    item.measurement = recorded;
    mockSave(store);
    return plan;
  },

  fitCurve(plan_id, excluded_sample_ids) {
    const store = mockLoad();
    const plan = store.plans[plan_id];
    if (!plan) mockFail(`Plan ${plan_id} not found.`);
    const pending = plan.items.filter((it) => it.measurement === null).length;
    if (pending > 0) mockFail(`${pending} tube(s) in ${plan_id} are still unread.`);

    const excluded = new Set(excluded_sample_ids ?? []);
    const sampleIds = new Set(plan.items.map((it) => it.measurement.sample_id));
    for (const id of excluded) if (!sampleIds.has(id)) mockFail(`Excluded sample ${id} is not in this plan.`);

    const included = plan.items.filter((it) => !excluded.has(it.measurement.sample_id));
    const stale = included.filter((it) => it.measurement.config_fingerprint !== plan.config_fingerprint);
    if (stale.length > 0) {
      mockFail(`${stale.length} reading(s) were taken under a different config; re-read or exclude them.`);
    }

    const points = included.map((it) => ({
      c: it.sample_type === "blank" ? 0 : it.concentration_nM,
      y: it.measurement.fluorescence,
      sd: Math.max(it.measurement.fluorescence_sd, 1e-6),
    }));
    const blanks = points.filter((pt) => pt.c === 0);
    const standardConcs = [...new Set(points.filter((pt) => pt.c > 0).map((pt) => pt.c))].sort((a, b) => a - b);
    if (blanks.length < 2) mockFail("Keep at least 2 blanks: LOD needs a blank SD.");
    if (standardConcs.length < 4) mockFail("Keep at least 4 distinct standard concentrations for a 4PL fit.");

    const { p, cov } = mockFit4PL(points);
    const [top, bottom, lnEc50, hill] = p;
    if (!cov || !cov.flat().every(Number.isFinite)) mockFail("Fit did not converge: parameter covariance is undefined.");
    if (!(top > bottom)) mockFail("No increasing response: top ≤ bottom, so no curve can be built.");

    const params = { top, bottom, ec50_nM: Math.exp(lnEc50), hill };
    const concentrationAt = (signal) => params.ec50_nM * ((signal - bottom) / (top - signal)) ** (1 / hill);

    // LOD / LOQ：blank 平均 + 3 / 10 倍 blank SD，再經曲線換成濃度。
    const blankYs = blanks.map((pt) => pt.y);
    const blankSd = mockSampleSd(blankYs) || mockMean(blanks.map((pt) => pt.sd));
    const blankLevel = Math.max(mockMean(blankYs), bottom);
    const lodSignal = blankLevel + 3 * blankSd;
    const loqSignal = blankLevel + 10 * blankSd;
    if (!(loqSignal < top)) mockFail("Blank scatter is too large relative to the signal span to define LOD/LOQ.");
    const lod_nM = concentrationAt(lodSignal);
    const loq_nM = concentrationAt(loqSignal);

    // 可信反推範圍：下限不低於 LOD 也不低於最低標準品；上限不超過最高標準品，
    // 也不超過 95% span（再往上曲線太平）。
    const range_nM = {
      min: Math.max(lod_nM, standardConcs[0]),
      max: Math.min(standardConcs[standardConcs.length - 1], params.ec50_nM * (MOCK_RANGE_SPAN_FRACTION / (1 - MOCK_RANGE_SPAN_FRACTION)) ** (1 / hill)),
    };
    if (!(range_nM.min < range_nM.max)) mockFail("No usable range: LOD is above the curve's upper limit.");

    const rmse = Math.sqrt(mockMean(points.map((pt) => (pt.y - mockModel(pt.c, p)) ** 2)));

    const curve = {
      curve_id: mockId("CURVE"),
      fitted_at: new Date().toISOString(),
      model: "4PL",
      params,
      lod_nM,
      loq_nM,
      rmse,
      range_nM,
      // 理由由頁面在 saveCurve 時補上；fitCurve 的簽章只收 sample id。
      excluded: [...excluded].map((sample_id) => ({ sample_id, reason: "" })),
      config_fingerprint: plan.config_fingerprint,
      timepoint: plan.timepoint,
      is_active: false,
    };
    store.drafts[curve.curve_id] = { curve, cov, noise: mockNoiseModel(points) };
    // 草稿只留最近 10 份，避免 localStorage 一直長大。
    const draftIds = Object.keys(store.drafts);
    for (const id of draftIds.slice(0, Math.max(0, draftIds.length - 10))) delete store.drafts[id];
    mockSave(store);
    return curve;
  },

  // 新曲線（草稿）：存檔並附上排除理由。已存在的曲線：只接受 is_active 的切換，
  // 參數一律以伺服器端存的為準。
  saveCurve(curve) {
    const store = mockLoad();
    if (!curve || !curve.curve_id) mockFail("curve_id is required.");
    const currentFingerprint = mockConfig(store).fingerprint;
    const setActive = (target) => {
      if (curve.is_active) {
        if (target.config_fingerprint !== currentFingerprint) {
          mockFail(`Curve ${target.curve_id} is bound to config ${target.config_fingerprint}; the instrument is now ${currentFingerprint}.`);
        }
        for (const other of Object.values(store.curves)) other.is_active = false;
      }
      target.is_active = Boolean(curve.is_active);
    };

    const existing = store.curves[curve.curve_id];
    if (existing) {
      setActive(existing);
      mockSave(store);
      return existing;
    }

    const draft = store.drafts[curve.curve_id];
    if (!draft) mockFail(`Curve ${curve.curve_id} was never fitted.`);
    const reasons = new Map((curve.excluded ?? []).map((e) => [e.sample_id, String(e.reason ?? "").trim()]));
    const draftIds = draft.curve.excluded.map((e) => e.sample_id);
    if (reasons.size !== draftIds.length || !draftIds.every((id) => reasons.has(id))) {
      mockFail("Excluded samples differ from the fit; fit again before saving.");
    }
    const missing = draftIds.filter((id) => !reasons.get(id));
    if (missing.length > 0) mockFail(`Give a reason for every excluded sample (${missing.join(", ")}).`);

    const saved = { ...draft.curve, excluded: draftIds.map((id) => ({ sample_id: id, reason: reasons.get(id) })), is_active: false };
    setActive(saved);
    store.curves[saved.curve_id] = saved;
    store.curve_private[saved.curve_id] = { cov: draft.cov, noise: draft.noise };
    delete store.drafts[saved.curve_id];
    mockSave(store);
    return saved;
  },

  listCurves() {
    return Object.values(mockLoad().curves).sort((a, b) => b.fitted_at.localeCompare(a.fitted_at));
  },

  getActiveCurve() {
    return mockActiveCurve(mockLoad());
  },

  invert(fluorescence, config_fingerprint) {
    const store = mockLoad();
    if (!Number.isFinite(fluorescence)) mockFail("fluorescence must be a number.");
    const active = mockActiveCurve(store);
    if (!active) return { concentration_nM: null, ci95_nM: null, status: "no_curve", curve_id: null };
    if (active.config_fingerprint !== config_fingerprint) {
      return { concentration_nM: null, ci95_nM: null, status: "config_mismatch", curve_id: active.curve_id };
    }
    const result = mockInverseCore(fluorescence, active, store.curve_private[active.curve_id]);
    return {
      concentration_nM: result.status === "ok" ? result.concentration_nM : null,
      ci95_nM: result.status === "ok" ? result.ci95_nM : null,
      status: result.status,
      curve_id: active.curve_id,
    };
  },

  // ---- 只給 mock 控制面板用 ----
  getSim() {
    return { ...mockLoad().sim };
  },

  setSim(patch) {
    const store = mockLoad();
    store.sim = { ...store.sim, ...patch };
    mockSave(store);
    return { ...store.sim };
  },

  reset() {
    mockMemoryStore = null;
    try {
      localStorage.removeItem(MOCK_STORE_KEY);
    } catch (err) {
      // 沒有 localStorage 就只清記憶體。
    }
  },
};
