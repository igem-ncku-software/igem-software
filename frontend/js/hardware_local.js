// =========================================================
// CAPTURE-Screen 的暫代後端：calibration plan / curve 的存取、4PL 加權擬合
// （Levenberg–Marquardt）、LOD/LOQ、濃度反推與 95% CI（delta method），以及
// 需要儲存狀態才能判斷的 QC flag。
//
// 不論 DEVICE_MODE 是 mock 還是 live 都用這支：裝置只負責讀值，儲存與擬合
// 目前沒有後端可以做（backend/app/hardware/ 尚未實作），所以先放在瀏覽器的
// localStorage（讀寫失敗時退回記憶體）。之後後端完成，這支整個由 HTTP 取代。
//
// 只收 mode 為 "measurement" 的讀值轉成的 Measurement；即時串流的資料不會
// 也不可以進到這裡。
//
// 頁面一律不直接呼叫這支，只透過 js/hardware_api.js。
// =========================================================

// 反推範圍的上限：4PL 到達 95% span 之後太平，反推誤差會爆掉。
const LOCAL_RANGE_SPAN_FRACTION = 0.95;
const LOCAL_STORE_KEY = "lasreader.hardware.local.v1";
// 舊版（mock 與儲存還沒拆開時）的 key，reset 時一併清掉。
const LOCAL_LEGACY_STORE_KEYS = ["lasreader.hardware.mock.v1"];

// ---- 狀態儲存 --------------------------------------------------------

function localDefaultStore() {
  return {
    plans: {},         // plan_id -> CalibrationPlan
    drafts: {},        // curve_id -> { curve, cov, noise }：已擬合、尚未存檔
    curves: {},        // curve_id -> CalibrationCurve：已存檔
    curve_private: {}, // curve_id -> { cov, noise }：反推 CI 需要，但不在資料契約裡
    blank_scatter: {}, // config fingerprint -> 最近一次合格 blank 的 scatter（HIGH_SCATTER 的基準）
  };
}

let localMemoryStore = null;

function localLoad() {
  try {
    const raw = localStorage.getItem(LOCAL_STORE_KEY);
    if (raw) return { ...localDefaultStore(), ...JSON.parse(raw) };
  } catch (err) {
    // localStorage 被停用或內容壞掉：退回記憶體。
  }
  return localMemoryStore ?? localDefaultStore();
}

function localSave(store) {
  localMemoryStore = store;
  try {
    localStorage.setItem(LOCAL_STORE_KEY, JSON.stringify(store));
  } catch (err) {
    // 同上，記憶體裡那份還在。
  }
}

// ---- 小工具 ----------------------------------------------------------

function localId(prefix) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return `${prefix}-${date}-${suffix}`;
}

function localFail(message) {
  throw new Error(message);
}

// plan 裡 label 用的濃度字串；超過 1000 nM 改寫成 µM，跟頁面的顯示規則一致。
function localConcentrationLabel(nM) {
  return nM > 1000 ? `${+(nM / 1000).toFixed(3)} µM` : `${+nM.toFixed(3)} nM`;
}

function localMean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function localSampleSd(values) {
  if (values.length < 2) return 0;
  const m = localMean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

// ---- 4PL -------------------------------------------------------------

// 擬合時的參數向量是 [top, bottom, ln(ec50_nM), hill]：用 ln(EC50) 讓 LM 在
// 對數尺度上走，EC50 也不會被推成負數。
function localModel(c, p) {
  if (c <= 0) return p[1];
  const u = Math.exp(p[3] * (p[2] - Math.log(c)));
  return p[1] + (p[0] - p[1]) / (1 + u);
}

function localGradient(c, p) {
  if (c <= 0) return [0, 1, 0, 0];
  const lnRatio = p[2] - Math.log(c);
  const s = 1 / (1 + Math.exp(p[3] * lnRatio)); // u 溢位成 Infinity 時 s = 0，仍然安全
  const span = p[0] - p[1];
  const ds = s * (1 - s); // = u / (1 + u)^2，數值上比直接算穩定
  return [s, 1 - s, -span * ds * p[3], -span * ds * lnRatio];
}

// ---- 線性代數（4x4 就夠） ---------------------------------------------

function localSolve(matrix, rhs) {
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

function localInverse(matrix) {
  const n = matrix.length;
  const columns = [];
  for (let j = 0; j < n; j++) {
    const e = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
    const col = localSolve(matrix, e);
    if (!col) return null;
    columns.push(col);
  }
  return Array.from({ length: n }, (_, i) => columns.map((col) => col[i]));
}

// ---- 擬合 ------------------------------------------------------------

function localGroupByConcentration(points) {
  const groups = new Map();
  for (const pt of points) {
    if (!groups.has(pt.c)) groups.set(pt.c, []);
    groups.get(pt.c).push(pt.y);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([c, ys]) => ({ c, ys, mean: localMean(ys) }));
}

// 單次讀值的變異數模型 var(F) = a + b·F²（加成 + 比例噪音），從重複管的
// 實際離散估出來。擬合的權重與反推 CI 都用它。
function localNoiseModel(points) {
  const groups = localGroupByConcentration(points).filter((g) => g.ys.length >= 2);
  if (groups.length === 0) {
    return { a: localMean(points.map((pt) => pt.sd * pt.sd)), b: 0 };
  }
  const xs = groups.map((g) => g.mean * g.mean);
  const vs = groups.map((g) => localSampleSd(g.ys) ** 2);
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

// 加權最小平方。每管的標準差取「該管自己的讀雜訊估計」與「重複管離散模型」
// 兩者較大者：真實裝置的 fluorescence_sd 只含讀雜訊（不含 shot noise），單獨
// 拿來當權重會讓幾管剛好暗值很穩的點權重大到失真。
function localFit4PL(points) {
  const groups = localGroupByConcentration(points);
  const bottom0 = groups[0].mean;
  let top0 = groups[groups.length - 1].mean;
  if (top0 <= bottom0) top0 = bottom0 + Math.abs(bottom0) * 0.01 + 1e-9;
  const mid = (top0 + bottom0) / 2;
  const nonzero = groups.filter((g) => g.c > 0);
  const nearest = nonzero.reduce((best, g) => (Math.abs(g.mean - mid) < Math.abs(best.mean - mid) ? g : best));
  let p = [top0, bottom0, Math.log(nearest.c), 1];

  const cost = (q) => points.reduce((acc, pt) => acc + ((pt.y - localModel(pt.c, q)) / pt.sd) ** 2, 0);

  const normalEquations = (q) => {
    const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const g = [0, 0, 0, 0];
    for (const pt of points) {
      const w = 1 / (pt.sd * pt.sd);
      const r = pt.y - localModel(pt.c, q);
      const J = localGradient(pt.c, q);
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
      const step = localSolve(damped, g);
      if (step) {
        const trial = p.map((v, i) => v + step[i]);
        if (trial[3] > 0.05 && trial[3] < 20) {
          const trialCost = cost(trial);
          if (trialCost < current) {
            converged = (current - trialCost) / Math.max(current, 1e-300) < 1e-10;
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
  const inv = localInverse(A);
  const dof = points.length - 4;
  const scale = dof > 0 ? current / dof : NaN;
  const cov = inv ? inv.map((row) => row.map((v) => v * scale)) : null;
  return { p, cov };
}

// 螢光 -> 濃度。只在曲線可信範圍內給點估計，範圍外只回 status，不外插。
function localInverseCore(F, curve, priv) {
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

function localActiveCurve(store) {
  return Object.values(store.curves).find((c) => c.is_active) ?? null;
}

// ---- 對 hardware_api.js / hardware_mock.js 公開 -----------------------

const HardwareLocal = {
  // HIGH_SCATTER 需要「同組態最近一次 blank」當基準。
  measurementContext(configFingerprint) {
    const value = localLoad().blank_scatter[configFingerprint];
    return { blankScatter: Number.isFinite(value) ? value : null };
  },

  // 讀值剛由 HardwareProcessing.toMeasurement() 組好之後呼叫：
  // 補上需要儲存狀態的 flag，並更新 blank 基準。
  finalizeMeasurement(m) {
    const store = localLoad();

    if (m.sample_type === "blank" && !m.flags.some((f) => ["HIGH_SCATTER", "NO_DARK_PAIR", "SATURATED"].includes(f))) {
      store.blank_scatter[m.config_fingerprint] = m.scatter;
    }

    // unknown 的 QC：跟 active 曲線比，規則和 invert() 完全一樣。
    const active = localActiveCurve(store);
    if (m.sample_type === "unknown" && active) {
      if (active.config_fingerprint !== m.config_fingerprint) {
        m.flags.push("STALE_CONFIG");
      } else {
        const { status } = localInverseCore(m.fluorescence, active, store.curve_private[active.curve_id]);
        if (status === "below_lod") m.flags.push("BELOW_LOD");
        if (status === "above_range") m.flags.push("ABOVE_RANGE");
      }
    }

    localSave(store);
    return m;
  },

  createCalibrationPlan(input, configFingerprint) {
    const store = localLoad();
    const { concentrations_nM, replicates, blanks, timepoint } = input ?? {};
    if (!configFingerprint) localFail("Instrument config unknown: a plan must be bound to the device's config.");
    if (!Array.isArray(concentrations_nM) || concentrations_nM.length === 0) localFail("Enter at least one concentration.");
    if (!concentrations_nM.every((c) => Number.isFinite(c) && c > 0)) localFail("Concentrations must be positive numbers.");
    const concentrations = [...new Set(concentrations_nM)].sort((a, b) => a - b);
    if (concentrations.length < 4) localFail("A 4PL fit needs at least 4 distinct concentrations.");
    if (!(Number.isInteger(replicates) && replicates >= 1 && replicates <= 10)) localFail("Replicates must be an integer from 1 to 10.");
    if (!(Number.isInteger(blanks) && blanks >= 2 && blanks <= 10)) localFail("Blanks must be an integer from 2 to 10 (LOD needs a blank SD).");
    if (!timepoint || !String(timepoint).trim()) localFail("Describe the timepoint.");

    // 以「重複輪」交錯排列：每一輪先 blank，再濃度由低到高。這樣儀器漂移不會
    // 集中在某個濃度上，單支 cuvette 從低濃度換到高濃度也比較不怕殘留。
    const items = [];
    const rounds = Math.max(replicates, blanks);
    for (let r = 1; r <= rounds; r++) {
      if (r <= blanks) items.push({ label: `blank r${r}`, sample_type: "blank", concentration_nM: null });
      if (r <= replicates) {
        for (const c of concentrations) {
          items.push({ label: `${localConcentrationLabel(c)} r${r}`, sample_type: "standard", concentration_nM: c });
        }
      }
    }

    const plan = {
      plan_id: localId("PLAN"),
      created_at: new Date().toISOString(),
      config_fingerprint: configFingerprint,
      timepoint: String(timepoint).trim(),
      items: items.map((item, i) => ({ slot: i + 1, ...item, measurement: null })),
    };
    store.plans[plan.plan_id] = plan;
    localSave(store);
    return plan;
  },

  getCalibrationPlan(plan_id) {
    const plan = localLoad().plans[plan_id];
    if (!plan) localFail(`Plan ${plan_id} not found.`);
    return plan;
  },

  recordPlanMeasurement(plan_id, slot, m) {
    const store = localLoad();
    const plan = store.plans[plan_id];
    if (!plan) localFail(`Plan ${plan_id} not found.`);
    const item = plan.items.find((it) => it.slot === slot);
    if (!item) localFail(`Slot ${slot} does not exist in ${plan_id}.`);

    // 單支 cuvette 必須照順序跑：只能量「下一管」，或重測已經量過的管。
    const next = plan.items.find((it) => it.measurement === null);
    if (item.measurement === null && next && next.slot !== slot) {
      localFail(`Slot ${slot} is out of order; the next tube is slot ${next.slot}.`);
    }
    if (!m || m.sample_type !== item.sample_type) localFail(`Slot ${slot} expects a ${item.sample_type} measurement.`);
    if (item.sample_type === "standard" && m.known_concentration_nM !== item.concentration_nM) {
      localFail(`Slot ${slot} expects ${item.concentration_nM} nM.`);
    }

    const recorded = { ...m, flags: [...m.flags] };
    if (recorded.config_fingerprint !== plan.config_fingerprint && !recorded.flags.includes("STALE_CONFIG")) {
      recorded.flags.push("STALE_CONFIG");
    }
    item.measurement = recorded;
    localSave(store);
    return plan;
  },

  fitCurve(plan_id, excluded_sample_ids) {
    const store = localLoad();
    const plan = store.plans[plan_id];
    if (!plan) localFail(`Plan ${plan_id} not found.`);
    const pending = plan.items.filter((it) => it.measurement === null).length;
    if (pending > 0) localFail(`${pending} tube(s) in ${plan_id} are still unread.`);

    const excluded = new Set(excluded_sample_ids ?? []);
    const sampleIds = new Set(plan.items.map((it) => it.measurement.sample_id));
    for (const id of excluded) if (!sampleIds.has(id)) localFail(`Excluded sample ${id} is not in this plan.`);

    const included = plan.items.filter((it) => !excluded.has(it.measurement.sample_id));
    const stale = included.filter((it) => it.measurement.config_fingerprint !== plan.config_fingerprint);
    if (stale.length > 0) {
      localFail(`${stale.length} reading(s) were taken under a different config; re-read or exclude them.`);
    }

    const points = included.map((it) => ({
      c: it.sample_type === "blank" ? 0 : it.concentration_nM,
      y: it.measurement.fluorescence,
      sd: it.measurement.fluorescence_sd,
    }));
    const blanks = points.filter((pt) => pt.c === 0);
    const standardConcs = [...new Set(points.filter((pt) => pt.c > 0).map((pt) => pt.c))].sort((a, b) => a - b);
    if (blanks.length < 2) localFail("Keep at least 2 blanks: LOD needs a blank SD.");
    if (standardConcs.length < 4) localFail("Keep at least 4 distinct standard concentrations for a 4PL fit.");

    const noise = localNoiseModel(points);
    const spanScale = Math.max(...points.map((pt) => Math.abs(pt.y)), 1e-12);
    for (const pt of points) {
      const modelSd = Math.sqrt(noise.a + noise.b * pt.y * pt.y);
      pt.sd = Math.max(pt.sd, modelSd, spanScale * 1e-9);
    }

    const { p, cov } = localFit4PL(points);
    const [top, bottom, lnEc50, hill] = p;
    if (!cov || !cov.flat().every(Number.isFinite)) localFail("Fit did not converge: parameter covariance is undefined.");
    if (!(top > bottom)) localFail("No increasing response: top ≤ bottom, so no curve can be built.");

    const params = { top, bottom, ec50_nM: Math.exp(lnEc50), hill };
    const concentrationAt = (signal) => params.ec50_nM * ((signal - bottom) / (top - signal)) ** (1 / hill);

    // LOD / LOQ：blank 平均 + 3 / 10 倍 blank SD，再經曲線換成濃度。
    const blankYs = blanks.map((pt) => pt.y);
    const blankSd = localSampleSd(blankYs) || localMean(blanks.map((pt) => pt.sd));
    const blankLevel = Math.max(localMean(blankYs), bottom);
    const lodSignal = blankLevel + 3 * blankSd;
    const loqSignal = blankLevel + 10 * blankSd;
    if (!(loqSignal < top)) localFail("Blank scatter is too large relative to the signal span to define LOD/LOQ.");
    const lod_nM = concentrationAt(lodSignal);
    const loq_nM = concentrationAt(loqSignal);

    // 可信反推範圍：下限不低於 LOD 也不低於最低標準品；上限不超過最高標準品，
    // 也不超過 95% span（再往上曲線太平）。
    const range_nM = {
      min: Math.max(lod_nM, standardConcs[0]),
      max: Math.min(
        standardConcs[standardConcs.length - 1],
        params.ec50_nM * (LOCAL_RANGE_SPAN_FRACTION / (1 - LOCAL_RANGE_SPAN_FRACTION)) ** (1 / hill),
      ),
    };
    if (!(range_nM.min < range_nM.max)) localFail("No usable range: LOD is above the curve's upper limit.");

    const rmse = Math.sqrt(localMean(points.map((pt) => (pt.y - localModel(pt.c, p)) ** 2)));

    const curve = {
      curve_id: localId("CURVE"),
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
    store.drafts[curve.curve_id] = { curve, cov, noise };
    // 草稿只留最近 10 份，避免 localStorage 一直長大。
    const draftIds = Object.keys(store.drafts);
    for (const id of draftIds.slice(0, Math.max(0, draftIds.length - 10))) delete store.drafts[id];
    localSave(store);
    return curve;
  },

  // 新曲線（草稿）：存檔並附上排除理由。已存在的曲線：只接受 is_active 的切換，
  // 參數一律以儲存端的為準。currentFingerprint 是裝置目前的組態，設為 active
  // 時用來確認曲線還適用；裝置連不上時為 null，這時不允許設為 active。
  saveCurve(curve, currentFingerprint) {
    const store = localLoad();
    if (!curve || !curve.curve_id) localFail("curve_id is required.");
    const setActive = (target) => {
      if (curve.is_active) {
        if (!currentFingerprint) {
          localFail("Device not reachable, so its current config can't be checked. A curve can only be set as active while the device is online.");
        }
        if (target.config_fingerprint !== currentFingerprint) {
          localFail(`Curve ${target.curve_id} is bound to config ${target.config_fingerprint}; the instrument is now ${currentFingerprint}.`);
        }
        for (const other of Object.values(store.curves)) other.is_active = false;
      }
      target.is_active = Boolean(curve.is_active);
    };

    const existing = store.curves[curve.curve_id];
    if (existing) {
      setActive(existing);
      localSave(store);
      return existing;
    }

    const draft = store.drafts[curve.curve_id];
    if (!draft) localFail(`Curve ${curve.curve_id} was never fitted.`);
    const reasons = new Map((curve.excluded ?? []).map((e) => [e.sample_id, String(e.reason ?? "").trim()]));
    const draftIds = draft.curve.excluded.map((e) => e.sample_id);
    if (reasons.size !== draftIds.length || !draftIds.every((id) => reasons.has(id))) {
      localFail("Excluded samples differ from the fit; fit again before saving.");
    }
    const missing = draftIds.filter((id) => !reasons.get(id));
    if (missing.length > 0) localFail(`Give a reason for every excluded sample (${missing.join(", ")}).`);

    const saved = { ...draft.curve, excluded: draftIds.map((id) => ({ sample_id: id, reason: reasons.get(id) })), is_active: false };
    setActive(saved);
    store.curves[saved.curve_id] = saved;
    store.curve_private[saved.curve_id] = { cov: draft.cov, noise: draft.noise };
    delete store.drafts[saved.curve_id];
    localSave(store);
    return saved;
  },

  listCurves() {
    return Object.values(localLoad().curves).sort((a, b) => b.fitted_at.localeCompare(a.fitted_at));
  },

  getActiveCurve() {
    return localActiveCurve(localLoad());
  },

  invert(fluorescence, config_fingerprint) {
    const store = localLoad();
    if (!Number.isFinite(fluorescence)) localFail("fluorescence must be a number.");
    const active = localActiveCurve(store);
    if (!active) return { concentration_nM: null, ci95_nM: null, status: "no_curve", curve_id: null };
    if (active.config_fingerprint !== config_fingerprint) {
      return { concentration_nM: null, ci95_nM: null, status: "config_mismatch", curve_id: active.curve_id };
    }
    const result = localInverseCore(fluorescence, active, store.curve_private[active.curve_id]);
    return {
      concentration_nM: result.status === "ok" ? result.concentration_nM : null,
      ci95_nM: result.status === "ok" ? result.ci95_nM : null,
      status: result.status,
      curve_id: active.curve_id,
    };
  },

  reset() {
    localMemoryStore = null;
    try {
      localStorage.removeItem(LOCAL_STORE_KEY);
      for (const key of LOCAL_LEGACY_STORE_KEYS) localStorage.removeItem(key);
    } catch (err) {
      // 沒有 localStorage 就只清記憶體。
    }
  },
};
