// =========================================================
// CAPTURE-Screen's temporary stand-in backend: calibration runs, curves and measurement batches
// kept in the browser, weighted 4PL fitting (Levenberg-Marquardt), LOD/LOQ, and concentration
// inversion with a 95% CI (delta method).
//
// The workflow it stores, in order:
//   run (CalibrationPlan)  standards + blanks under stated conditions, read tube by tube or entered by hand
//   curve                  a 4PL fitted from one run, bound to its config, signal and conditions
//   batch                  blanks, then samples read in replicate tubes, each sample converted
//                          through the one curve the batch was started with
//
// The device only takes readings (via the backend's POST /api/hardware/read); the backend has no
// storage or fitting yet, so this lives in localStorage (falling back to memory if reads/writes
// fail). Once the backend has storage, this whole file gets replaced by HTTP calls.
//
// Holds only Measurements converted from a mode "measurement" reading, or readings recorded
// earlier and entered by hand (source "manual"); live-stream data never can and never should reach this.
//
// Pages never call this directly — only through js/hardware_api.js.
// =========================================================

// Upper bound on the inversion range: past 95% of the 4PL span the curve is too flat, and inversion error blows up.
const LOCAL_RANGE_SPAN_FRACTION = 0.95;
// How many measurement batches are kept. It has to be capped: localSave() swallows a
// QuotaExceededError, so storage left to grow would eventually stop runs and curves persisting
// too, silently. A batch of ten samples in triplicate is ~25 KB, so this stays well under any
// browser's budget. When full, the oldest batch that has been exported makes room; a batch that
// exists nowhere but here is never dropped.
const LOCAL_BATCH_LIMIT = 60;
// One file holding everything, so a restore can't quietly bring back half of it.
const LOCAL_BACKUP_FORMAT = "lasreader.hardware.backup";
// Version 2 is the step-by-step workflow (conditions, signal ids, batches). Version 1 files hold
// runs without conditions and a flat reading log, which this build no longer reads.
const LOCAL_BACKUP_VERSION = 2;
const LOCAL_STORE_KEY = "lasreader.hardware.local.v3";
// Cleared on load. v1 and older came from the removed simulated device; v2 is the previous
// workflow, whose data the user chose to clear rather than migrate (2026-09-27). The v3 dark-read
// time belonged to the Instrument page's old dark-read reminder, since removed.
const LOCAL_LEGACY_KEYS = [
  "lasreader.hardware.v3.lastDarkReadUtc",
  "lasreader.hardware.local.v1",
  "lasreader.hardware.mock.v1",
  "lasreader.hardware.mockDevice.v1",
  "lasreader.hardware.lastPlanId",
  "lasreader.hardware.lastDarkReadUtc",
  "lasreader.hardware.local.v2",
  "lasreader.hardware.v2.lastPlanId",
  "lasreader.hardware.v2.lastDarkReadUtc",
  "lasreader.hardware.v2.lastBackupUtc",
];

try {
  for (const key of LOCAL_LEGACY_KEYS) localStorage.removeItem(key);
} catch (err) {
  // localStorage is unavailable, so there's no old data to clear either.
}

// ---- State storage --------------------------------------------------------

function localDefaultStore() {
  return {
    plans: {},         // plan_id -> CalibrationPlan
    drafts: {},        // curve_id -> { curve, cov, noise }: fitted but not yet saved
    curves: {},        // curve_id -> CalibrationCurve: saved, never changed afterwards
    curve_private: {}, // curve_id -> { cov, noise }: needed for inversion CI, but not part of the data contract
    blank_scatter: {}, // config fingerprint -> scatter of the most recent passing blank (the HIGH_SCATTER baseline)
    batches: {},       // batch_id -> MeasurementBatch
  };
}

let localMemoryStore = null;

// Every key this software has ever written starts with this. Reset matches on the prefix instead
// of a list of names so nothing the software writes later can be left behind, and — since an
// origin's storage is shared by everything served from it (igem-ncku-software.github.io hosts
// more than this one site) — so that nothing belonging to anyone else is touched.
const LOCAL_KEY_PREFIX = "lasreader.";

// A reset in another tab has to reach this tab's memory copy too. localLoad() falls back to that
// copy whenever the key is missing, so a tab that kept its own would put the deleted data straight
// back on its next save. key is null when the whole storage was cleared.
window.addEventListener("storage", (event) => {
  if (event.key === null || event.key === LOCAL_STORE_KEY) localMemoryStore = null;
});

function localLoad() {
  try {
    const raw = localStorage.getItem(LOCAL_STORE_KEY);
    if (raw) return { ...localDefaultStore(), ...JSON.parse(raw) };
  } catch (err) {
    // localStorage is disabled or its contents are corrupt: fall back to memory.
  }
  return localMemoryStore ?? localDefaultStore();
}

function localSave(store) {
  localMemoryStore = store;
  try {
    localStorage.setItem(LOCAL_STORE_KEY, JSON.stringify(store));
  } catch (err) {
    // Same as above; the in-memory copy is still there.
  }
}

// ---- Small helpers ----------------------------------------------------------

// Collected before anything is removed: removing while walking localStorage by index skips keys,
// because each removal shifts the ones after it.
function localStoredKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && key.startsWith(LOCAL_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

function localId(prefix) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return `${prefix}-${date}-${suffix}`;
}

function localFail(message) {
  throw new Error(message);
}

function localIsDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

// The concentration string used in a plan's label; above 1000 nM it's rewritten as µM, matching the page's display rule.
function localConcentrationLabel(nM) {
  return nM > 1000 ? `${+(nM / 1000).toFixed(3)} µM` : `${+nM.toFixed(3)} nM`;
}

// A YYYY-MM-DD calendar date that exists and isn't after today (local time).
function localIsPastDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d && date <= new Date();
}

function localMean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function localSampleSd(values) {
  if (values.length < 2) return 0;
  const m = localMean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

// ---- Experimental conditions ----------------------------------------------
// What a curve is valid for beyond the instrument config: which biosensor strain, and how long
// after AHL was added it was read. A sample only converts through a curve made under the same
// conditions, so both are required, and induction time is a number rather than free text so it
// can be compared.

const LOCAL_TEXT_LIMIT = 200;

function localConditionsProblem(c) {
  if (!c || typeof c !== "object") return "conditions are missing";
  if (typeof c.sensor !== "string" || !c.sensor.trim()) return "Enter the biosensor strain.";
  if (c.sensor.length > LOCAL_TEXT_LIMIT) return "The biosensor strain is too long.";
  if (!(Number.isFinite(c.induction_h) && c.induction_h > 0 && c.induction_h <= 1000)) {
    return "Induction time must be a number of hours above 0.";
  }
  if (typeof c.notes !== "string" || c.notes.length > LOCAL_TEXT_LIMIT * 5) return "Notes are too long.";
  return null;
}

function localConditions(input) {
  const conditions = {
    sensor: String(input?.sensor ?? "").trim(),
    induction_h: Number(input?.induction_h),
    notes: String(input?.notes ?? "").trim(),
  };
  const problem = localConditionsProblem(conditions);
  if (problem) localFail(problem);
  return conditions;
}

// ---- 4PL -------------------------------------------------------------

// The parameter vector during fitting is [top, bottom, ln(ec50_nM), hill]: using ln(EC50)
// keeps LM stepping on a log scale and stops EC50 from ever being pushed negative.
function localModel(c, p) {
  if (c <= 0) return p[1];
  const u = Math.exp(p[3] * (p[2] - Math.log(c)));
  return p[1] + (p[0] - p[1]) / (1 + u);
}

function localGradient(c, p) {
  if (c <= 0) return [0, 1, 0, 0];
  const lnRatio = p[2] - Math.log(c);
  const s = 1 / (1 + Math.exp(p[3] * lnRatio)); // still safe when u overflows to Infinity, giving s = 0
  const span = p[0] - p[1];
  const ds = s * (1 - s); // = u / (1 + u)^2, more numerically stable than computing it directly
  return [s, 1 - s, -span * ds * p[3], -span * ds * lnRatio];
}

// ---- Linear algebra (4x4 is enough) ---------------------------------------

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

// ---- Fitting ------------------------------------------------------------

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

// Variance model for a single reading, var(F) = a + b*F^2 (additive + proportional noise),
// estimated from the actual spread across replicate tubes. Used both for fit weights and for inversion CI.
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

// Weighted least squares. Each tube's standard deviation is the larger of "that tube's own
// read-noise estimate" and "the replicate-spread model": the real device's fluorescence_sd
// only captures read noise (no shot noise), so using it alone as the weight would let a few
// tubes with an unusually stable dark level get distorted, oversized weight.
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

  // Parameter covariance = (J^T W J)^-1 * reduced chi^2
  const { A } = normalEquations(p);
  const inv = localInverse(A);
  const dof = points.length - 4;
  const scale = dof > 0 ? current / dof : NaN;
  const cov = inv ? inv.map((row) => row.map((v) => v * scale)) : null;
  return { p, cov };
}

// Signal -> concentration. Only gives a point estimate within the curve's trusted range; outside
// it, only status comes back, never an extrapolation. F is the mean of n tubes, so the reading's
// own variance is divided by n; the curve's parameter uncertainty is not, since every tube shares it.
function localInverseCore(F, curve, priv, n = 1) {
  const { top, bottom, ec50_nM, hill } = curve.params;
  if (!(F > bottom)) return { status: "below_lod" };
  if (!(F < top)) return { status: "above_range" };

  const lnRatio = Math.log((F - bottom) / (top - F));
  const lnC = Math.log(ec50_nM) + lnRatio / hill;
  const c = Math.exp(lnC);
  if (c < curve.range_nM.min) return { status: "below_lod" };
  if (c > curve.range_nM.max) return { status: "above_range" };

  // delta method on ln(c): the reading's own variance plus the parameter covariance
  const gF = (1 / hill) * (1 / (F - bottom) + 1 / (top - F));
  const gTheta = [-(1 / hill) / (top - F), -(1 / hill) / (F - bottom), 1, -lnRatio / (hill * hill)];
  let variance = (gF * gF * (priv.noise.a + priv.noise.b * F * F)) / n;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) variance += gTheta[i] * priv.cov[i][j] * gTheta[j];
  }
  const half = 1.96 * Math.sqrt(Math.max(variance, 0));
  return { status: "ok", concentration_nM: c, ci95_nM: [Math.exp(lnC - half), Math.exp(lnC + half)] };
}

// ---- Batches ---------------------------------------------------------------

// A tube a user left out stays in the batch with its reason; one read under a different config
// or signal is left out automatically, with the reason saying so.
function localIncludedTubes(tubes) {
  return tubes.filter((tube) => tube.excluded_reason === null);
}

// The estimate for one group of tubes (a sample, or the batch's blanks): the mean of the included
// tubes' signals, converted once. Stored as computed; recomputed only when that group's tubes
// change, always against the batch's own curve.
function localGroupEstimate(tubes, curve, priv) {
  const ys = localIncludedTubes(tubes).map((tube) => tube.measurement.fluorescence);
  const base = { curve_id: curve.curve_id, n: ys.length, mean_signal: null, sd_signal: null };
  if (ys.length === 0) return { ...base, status: "no_tubes", concentration_nM: null, ci95_nM: null };
  const mean = localMean(ys);
  const result = localInverseCore(mean, curve, priv, ys.length);
  return {
    ...base,
    mean_signal: mean,
    sd_signal: ys.length >= 2 ? localSampleSd(ys) : null,
    status: result.status,
    concentration_nM: result.status === "ok" ? result.concentration_nM : null,
    ci95_nM: result.status === "ok" ? result.ci95_nM : null,
  };
}

function localBatchCurve(store, batch) {
  const curve = store.curves[batch.curve_id];
  const priv = store.curve_private[batch.curve_id];
  if (!curve || !priv) localFail(`Curve ${batch.curve_id} is no longer stored, so this batch can't take readings.`);
  return { curve, priv };
}

function localRecomputeBatch(store, batch) {
  const { curve, priv } = localBatchCurve(store, batch);
  batch.blank_estimate = localGroupEstimate(batch.blanks, curve, priv);
  for (const sample of batch.samples) sample.estimate = localGroupEstimate(sample.tubes, curve, priv);
}

// What a batch keeps of its curve, so an exported row can be read without the curve.
function localCurveSnapshot(curve) {
  return {
    curve_id: curve.curve_id,
    conditions: curve.conditions,
    signal: curve.signal,
    config_fingerprint: curve.config_fingerprint,
    lod_nM: curve.lod_nM,
    loq_nM: curve.loq_nM,
    range_nM: curve.range_nM,
  };
}

function localFindTube(batch, sample_id) {
  for (const tube of batch.blanks) if (tube.measurement.sample_id === sample_id) return tube;
  for (const sample of batch.samples) {
    for (const tube of sample.tubes) if (tube.measurement.sample_id === sample_id) return tube;
  }
  return null;
}

function localBatchSummary(batch) {
  return {
    batch_id: batch.batch_id,
    created_at: batch.created_at,
    finished_at: batch.finished_at,
    exported_at: batch.exported_at,
    curve_id: batch.curve_id,
    conditions: batch.curve.conditions,
    blanks: batch.blanks.length,
    samples: batch.samples.length,
    tubes: batch.blanks.length + batch.samples.reduce((sum, sample) => sum + sample.tubes.length, 0),
  };
}

// Oldest exported batch first; never one that exists only here.
function localMakeRoomForBatch(store) {
  const batches = Object.values(store.batches).sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (batches.length < LOCAL_BATCH_LIMIT) return;
  const exported = batches.find((batch) => batch.exported_at !== null);
  if (!exported) {
    localFail(`${LOCAL_BATCH_LIMIT} batches are stored and none has been exported. Export them (CSV, or a backup on the Data page) to make room.`);
  }
  delete store.batches[exported.batch_id];
}

// ---- Validating imported entries --------------------------------------------
// A backup file is untrusted: hand-edited, from another build, or not ours at all. Every field a
// later calculation touches is checked, because a bad entry would go on converting real readings
// into wrong concentrations.

// One stored reading. expectedType is the sample type its place in a run or batch requires, and
// item is the plan slot it claims to fill (or null outside a run).
function localMeasurementProblem(m, expectedType, item = null) {
  const finite = (value) => Number.isFinite(value);
  const nullOrFinite = (value) => value === null || finite(value);
  if (!m || typeof m !== "object") return "measurement is not an object";
  if (typeof m.sample_id !== "string" || !m.sample_id.trim()) return "measurement.sample_id is missing";
  if (!localIsDate(m.timestamp_utc)) return "measurement.timestamp_utc is not a date";
  if (m.sample_type !== expectedType) return `measurement.sample_type "${m.sample_type}" should be "${expectedType}"`;
  if (item && item.sample_type === "standard") {
    if (m.known_concentration_nM !== item.concentration_nM) return "measurement.known_concentration_nM does not match the slot";
  } else if (m.known_concentration_nM !== null) {
    return "only a standard may carry known_concentration_nM";
  }
  if (typeof m.signal !== "string" || !m.signal.trim()) return "measurement.signal is missing";
  if (!finite(m.fluorescence)) return "measurement.fluorescence is not a number";
  // Null on both: a manual entry records neither read noise nor scatter.
  if (!nullOrFinite(m.fluorescence_sd)) return "measurement.fluorescence_sd is neither a number nor null";
  if (!nullOrFinite(m.scatter)) return "measurement.scatter is neither a number nor null";
  if (!Array.isArray(m.flags) || !m.flags.every((flag) => typeof flag === "string")) return "measurement.flags is malformed";
  if (!/^[0-9a-f]{6}$/.test(String(m.config_fingerprint))) return "measurement.config_fingerprint is malformed";
  if (!["device", "manual"].includes(m.source)) return `unknown measurement.source "${m.source}"`;
  // raw is only ever displayed and exported, never computed from, so it is checked loosely.
  if (m.raw !== null) {
    if (!m.raw || typeof m.raw !== "object") return "measurement.raw is neither an object nor null";
    if (!Object.values(m.raw).every(finite)) return "measurement.raw holds a non-number";
  }
  return null;
}

function localPlanProblem(entry) {
  if (!entry || typeof entry !== "object") return "not an object";
  if (typeof entry.plan_id !== "string" || !entry.plan_id.trim()) return "plan_id is missing";
  if (!localIsDate(entry.created_at)) return "created_at is not a date";
  if (!["device", "manual"].includes(entry.source)) return `unknown source "${entry.source}"`;
  if (entry.measured_on !== null && !localIsPastDate(entry.measured_on)) return "measured_on is neither a past date nor null";
  if (!/^[0-9a-f]{6}$/.test(String(entry.config_fingerprint))) return "config_fingerprint is malformed";
  if (typeof entry.signal !== "string" || !entry.signal.trim()) return "signal is missing";
  const conditions = localConditionsProblem(entry.conditions);
  if (conditions) return `conditions: ${conditions}`;
  if (!Array.isArray(entry.items) || entry.items.length === 0) return "items is missing";

  const slots = new Set();
  for (const item of entry.items) {
    if (!item || typeof item !== "object") return "an item is not an object";
    if (!Number.isInteger(item.slot) || item.slot < 1) return "an item has a bad slot number";
    // Duplicate slots would make the run disagree with itself about which tube is next.
    if (slots.has(item.slot)) return `slot ${item.slot} appears twice`;
    slots.add(item.slot);
    if (typeof item.label !== "string" || !item.label.trim()) return `slot ${item.slot}: label is missing`;
    if (!["blank", "standard"].includes(item.sample_type)) return `slot ${item.slot}: unknown sample_type`;
    if (item.sample_type === "blank") {
      if (item.concentration_nM !== null) return `slot ${item.slot}: a blank must carry concentration_nM null`;
    } else if (!(Number.isFinite(item.concentration_nM) && item.concentration_nM > 0)) {
      return `slot ${item.slot}: concentration_nM must be positive`;
    }
    if (item.measurement !== null) {
      const problem = localMeasurementProblem(item.measurement, item.sample_type, item);
      if (problem) return `slot ${item.slot}: ${problem}`;
    }
  }
  // A manual dataset has every slot filled at creation and can't take a reading, so a gap here
  // would be a run that can never be completed.
  if (entry.source === "manual" && entry.items.some((item) => item.measurement === null)) {
    return "a manual dataset cannot have an unread slot";
  }
  return null;
}

// A curve that gets past this will convert real readings into concentrations, so every field a
// later calculation touches is checked here rather than trusted.
function localCurveProblem(entry) {
  const finite = (value) => Number.isFinite(value);
  if (!entry || typeof entry !== "object") return "not an object";
  if (typeof entry.curve_id !== "string" || !entry.curve_id.trim()) return "curve_id is missing";
  if (entry.model !== "4PL") return `unsupported model "${entry.model}"`;
  if (!localIsDate(entry.fitted_at)) return "fitted_at is not a date";
  if (!["device", "manual"].includes(entry.source)) return `unknown source "${entry.source}"`;
  if (typeof entry.plan_id !== "string" || !entry.plan_id.trim()) return "plan_id is missing";
  if (!/^[0-9a-f]{6}$/.test(String(entry.config_fingerprint))) return "config_fingerprint is malformed";
  if (typeof entry.signal !== "string" || !entry.signal.trim()) return "signal is missing";
  const conditions = localConditionsProblem(entry.conditions);
  if (conditions) return `conditions: ${conditions}`;

  const params = entry.params;
  if (!params || typeof params !== "object") return "params is missing";
  if (![params.top, params.bottom, params.ec50_nM, params.hill].every(finite)) return "params are not all numbers";
  // The same invariants fitCurve() enforces: without them the 4PL cannot be inverted sensibly.
  if (!(params.top > params.bottom)) return "params.top is not above params.bottom";
  if (!(params.ec50_nM > 0)) return "params.ec50_nM is not positive";
  if (!(params.hill > 0)) return "params.hill is not positive";

  if (![entry.lod_nM, entry.loq_nM, entry.rmse].every(finite)) return "lod_nM / loq_nM / rmse are not all numbers";
  const range = entry.range_nM;
  if (!range || !finite(range.min) || !finite(range.max) || !(range.min < range.max)) return "range_nM is malformed";

  if (!Array.isArray(entry.excluded)) return "excluded is missing";
  for (const item of entry.excluded) {
    if (!item || typeof item.sample_id !== "string" || typeof item.reason !== "string") return "an excluded entry is malformed";
  }

  // localInverseCore() reaches straight into these, so a curve without them would not merely lose
  // its confidence interval — the first conversion would throw.
  const priv = entry.private;
  if (!priv || typeof priv !== "object") return "fit internals are missing";
  if (!priv.noise || !finite(priv.noise.a) || !finite(priv.noise.b)) return "fit internals: the noise model is malformed";
  if (!Array.isArray(priv.cov) || priv.cov.length !== 4) return "fit internals: the covariance is not 4x4";
  for (const row of priv.cov) {
    if (!Array.isArray(row) || row.length !== 4 || !row.every(finite)) return "fit internals: the covariance is not 4x4";
  }
  return null;
}

// An estimate is checked as strictly as a measurement: a restored row that claims a concentration
// outside the "ok" status would read as a result the curve never gave.
function localEstimateProblem(estimate) {
  const finite = (value) => Number.isFinite(value);
  if (!estimate || typeof estimate !== "object") return "estimate is missing";
  if (!["ok", "below_lod", "above_range", "no_tubes"].includes(estimate.status)) return `unknown estimate.status "${estimate.status}"`;
  if (estimate.status === "ok") {
    if (!finite(estimate.concentration_nM)) return "estimate.concentration_nM is not a number";
    if (!Array.isArray(estimate.ci95_nM) || estimate.ci95_nM.length !== 2 || !estimate.ci95_nM.every(finite)) {
      return "estimate.ci95_nM is malformed";
    }
  } else if (estimate.concentration_nM !== null || estimate.ci95_nM !== null) {
    return 'only an "ok" estimate may carry a concentration';
  }
  if (!(Number.isInteger(estimate.n) && estimate.n >= 0)) return "estimate.n is malformed";
  if (!(estimate.mean_signal === null || finite(estimate.mean_signal))) return "estimate.mean_signal is malformed";
  if (!(estimate.sd_signal === null || finite(estimate.sd_signal))) return "estimate.sd_signal is malformed";
  return null;
}

function localTubesProblem(tubes, expectedType) {
  if (!Array.isArray(tubes)) return "tubes are missing";
  for (const tube of tubes) {
    if (!tube || typeof tube !== "object") return "a tube is not an object";
    if (!(tube.excluded_reason === null || (typeof tube.excluded_reason === "string" && tube.excluded_reason.trim()))) {
      return "a tube's excluded_reason is malformed";
    }
    const problem = localMeasurementProblem(tube.measurement, expectedType);
    if (problem) return problem;
  }
  return null;
}

function localBatchProblem(entry) {
  const finite = (value) => Number.isFinite(value);
  if (!entry || typeof entry !== "object") return "not an object";
  if (typeof entry.batch_id !== "string" || !entry.batch_id.trim()) return "batch_id is missing";
  if (!localIsDate(entry.created_at)) return "created_at is not a date";
  if (!(entry.finished_at === null || localIsDate(entry.finished_at))) return "finished_at is neither a date nor null";
  if (!(entry.exported_at === null || localIsDate(entry.exported_at))) return "exported_at is neither a date nor null";
  if (typeof entry.curve_id !== "string" || !entry.curve_id.trim()) return "curve_id is missing";
  if (!(Number.isInteger(entry.tubes_per_sample) && entry.tubes_per_sample >= 1 && entry.tubes_per_sample <= 10)) {
    return "tubes_per_sample is malformed";
  }
  if (typeof entry.notes !== "string") return "notes is malformed";

  const curve = entry.curve;
  if (!curve || typeof curve !== "object" || curve.curve_id !== entry.curve_id) return "curve snapshot is missing or names another curve";
  if (localConditionsProblem(curve.conditions)) return "curve snapshot: conditions are malformed";
  if (typeof curve.signal !== "string" || !/^[0-9a-f]{6}$/.test(String(curve.config_fingerprint))) {
    return "curve snapshot: signal or config is malformed";
  }
  if (![curve.lod_nM, curve.loq_nM].every(finite) || !curve.range_nM || !finite(curve.range_nM.min) || !finite(curve.range_nM.max)) {
    return "curve snapshot: limits are malformed";
  }

  const blanks = localTubesProblem(entry.blanks, "blank");
  if (blanks) return `blanks: ${blanks}`;
  const blankEstimate = localEstimateProblem(entry.blank_estimate);
  if (blankEstimate) return `blanks: ${blankEstimate}`;
  if (!Array.isArray(entry.samples)) return "samples are missing";
  const names = new Set();
  for (const sample of entry.samples) {
    if (!sample || typeof sample.name !== "string" || !sample.name.trim()) return "a sample has no name";
    if (names.has(sample.name)) return `sample "${sample.name}" appears twice`;
    names.add(sample.name);
    const tubes = localTubesProblem(sample.tubes, "unknown");
    if (tubes) return `sample "${sample.name}": ${tubes}`;
    const estimate = localEstimateProblem(sample.estimate);
    if (estimate) return `sample "${sample.name}": ${estimate}`;
  }
  return null;
}

// One section of a backup into the store. Every section follows the same two rules: an id already
// stored is kept rather than replaced (what is here was produced on this machine; the file is a
// copy of something older), and whatever fails validation is reported with a reason instead of
// vanishing.
function localImportSection(entries, idField, problemOf, exists, store) {
  const imported = [];
  const skipped = [];
  const rejected = [];
  for (const entry of entries) {
    const id = typeof entry?.[idField] === "string" && entry[idField].trim() ? entry[idField] : `(no ${idField})`;
    const problem = problemOf(entry);
    if (problem) rejected.push({ id, reason: problem });
    else if (exists(entry[idField])) skipped.push(id);
    else {
      store(entry);
      imported.push(id);
    }
  }
  return { imported, skipped, rejected };
}

// ---- Exposed to hardware_api.js -----------------------------------------

const HardwareLocal = {
  // HIGH_SCATTER needs "the most recent blank under the same config" as its baseline.
  measurementContext(configFingerprint) {
    const value = localLoad().blank_scatter[configFingerprint];
    return { blankScatter: Number.isFinite(value) ? value : null };
  },

  // Called right after HardwareProcessing.toMeasurement() has assembled a reading. Only sample
  // reads go through here (a calibration run and a measurement batch); the Instrument page's
  // self-check goes through HardwareApi.runSelfCheck(), which skips this entirely.
  finalizeMeasurement(m) {
    const store = localLoad();
    // The HIGH_SCATTER baseline, and so what counts as "too cloudy", is whatever blank was read
    // last. That must be a cell blank — cells at the standards' OD, no AHL. A buffer-only cuvette
    // would set it far below any real sample and flag everything read after it.
    if (m.sample_type === "blank" && !m.flags.some((f) => ["HIGH_SCATTER", "NO_DARK_PAIR", "SATURATED"].includes(f))) {
      store.blank_scatter[m.config_fingerprint] = m.scatter;
      localSave(store);
    }
    return m;
  },

  // ---- Calibration runs ---------------------------------------------------

  createCalibrationPlan(input, configFingerprint, signal) {
    const store = localLoad();
    const { concentrations_nM, replicates, blanks } = input ?? {};
    if (!configFingerprint) localFail("Instrument config unknown: a run must be bound to the device's config.");
    if (!signal) localFail("Signal definition unknown.");
    const conditions = localConditions(input?.conditions);
    if (!Array.isArray(concentrations_nM) || concentrations_nM.length === 0) localFail("Enter at least one concentration.");
    if (!concentrations_nM.every((c) => Number.isFinite(c) && c > 0)) localFail("Concentrations must be positive numbers.");
    const concentrations = [...new Set(concentrations_nM)].sort((a, b) => a - b);
    if (concentrations.length < 4) localFail("A 4PL fit needs at least 4 distinct concentrations.");
    if (!(Number.isInteger(replicates) && replicates >= 1 && replicates <= 10)) localFail("Replicates must be an integer from 1 to 10.");
    if (!(Number.isInteger(blanks) && blanks >= 2 && blanks <= 10)) localFail("Blanks must be an integer from 2 to 10 (LOD needs a blank SD).");

    // Interleaved by "replicate round": each round is a blank, then concentrations low to high.
    // This keeps instrument drift from concentrating on any one concentration, and makes carryover
    // less of a concern when the single cuvette moves from a low to a high concentration.
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
      plan_id: localId("RUN"),
      created_at: new Date().toISOString(),
      source: "device",
      measured_on: null,
      config_fingerprint: configFingerprint,
      signal,
      conditions,
      items: items.map((item, i) => ({ slot: i + 1, ...item, measurement: null })),
    };
    store.plans[plan.plan_id] = plan;
    localSave(store);
    return plan;
  },

  // Readings recorded earlier and entered by hand, stored as a run whose every slot is already
  // filled, so fitting, exclusions, and saving work exactly as they do for a device run. Slots
  // keep the order the rows were entered in. Nothing that wasn't recorded (read-noise SD,
  // scatter, channels) is filled in: those fields stay null.
  createManualDataset(input, configFingerprint, signal) {
    const store = localLoad();
    const { measured_on, rows } = input ?? {};
    if (!/^[0-9a-f]{6}$/.test(String(configFingerprint))) localFail("Instrument config unknown: a dataset must be bound to a config.");
    if (!signal) localFail("Signal definition unknown.");
    const conditions = localConditions(input?.conditions);
    if (!localIsPastDate(measured_on)) localFail("Measured on must be a date no later than today.");
    if (!Array.isArray(rows) || rows.length === 0) localFail("Enter at least one row.");

    rows.forEach((row, i) => {
      if (row?.sample_type === "standard") {
        if (!(Number.isFinite(row.concentration_nM) && row.concentration_nM > 0)) {
          localFail(`Row ${i + 1}: concentration must be a positive number.`);
        }
      } else if (row?.sample_type !== "blank") {
        localFail(`Row ${i + 1}: type must be blank or standard.`);
      }
      if (!(Number.isFinite(row.fluorescence) && row.fluorescence >= 0)) localFail(`Row ${i + 1}: signal must be a number ≥ 0.`);
    });
    const concentrations = new Set(rows.filter((row) => row.sample_type === "standard").map((row) => row.concentration_nM));
    if (concentrations.size < 4) localFail("A 4PL fit needs at least 4 distinct concentrations.");
    if (rows.filter((row) => row.sample_type === "blank").length < 2) localFail("Enter at least 2 blanks: LOD needs a blank SD.");

    const plan_id = localId("RUN");
    const replicateCount = new Map();
    const items = rows.map((row, i) => {
      const slot = i + 1;
      const blank = row.sample_type === "blank";
      const key = blank ? "blank" : row.concentration_nM;
      const replicate = (replicateCount.get(key) ?? 0) + 1;
      replicateCount.set(key, replicate);
      return {
        slot,
        label: blank ? `blank r${replicate}` : `${localConcentrationLabel(row.concentration_nM)} r${replicate}`,
        sample_type: row.sample_type,
        concentration_nM: blank ? null : row.concentration_nM,
        measurement: {
          sample_id: `${plan_id}-${String(slot).padStart(2, "0")}`,
          timestamp_utc: measured_on,
          sample_type: row.sample_type,
          known_concentration_nM: blank ? null : row.concentration_nM,
          signal,
          fluorescence: row.fluorescence,
          fluorescence_sd: null,
          scatter: null,
          flags: [],
          config_fingerprint: configFingerprint,
          raw: null,
          source: "manual",
        },
      };
    });

    const plan = {
      plan_id,
      created_at: new Date().toISOString(),
      source: "manual",
      measured_on,
      config_fingerprint: configFingerprint,
      signal,
      conditions,
      items,
    };
    store.plans[plan_id] = plan;
    localSave(store);
    return plan;
  },

  getCalibrationPlan(plan_id) {
    const plan = localLoad().plans[plan_id];
    if (!plan) localFail(`Run ${plan_id} not found.`);
    return plan;
  },

  // Newest first. Only what a list needs, so a page doesn't have to hold every reading in memory
  // to show a row per run.
  listCalibrationPlans() {
    const store = localLoad();
    const curves = Object.values(store.curves);
    return Object.values(store.plans)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((plan) => ({
        plan_id: plan.plan_id,
        created_at: plan.created_at,
        source: plan.source,
        measured_on: plan.measured_on,
        config_fingerprint: plan.config_fingerprint,
        signal: plan.signal,
        conditions: plan.conditions,
        total: plan.items.length,
        read: plan.items.filter((item) => item.measurement !== null).length,
        curve_ids: curves.filter((curve) => curve.plan_id === plan.plan_id).map((curve) => curve.curve_id),
      }));
  },

  recordPlanMeasurement(plan_id, slot, m) {
    const store = localLoad();
    const plan = store.plans[plan_id];
    if (!plan) localFail(`Run ${plan_id} not found.`);
    if (plan.source === "manual") localFail(`${plan_id} holds entered data; its values can't be replaced.`);
    const item = plan.items.find((it) => it.slot === slot);
    if (!item) localFail(`Slot ${slot} does not exist in ${plan_id}.`);

    // The single cuvette has to run in order: only the "next tube" can be measured, or an already-measured tube redone.
    const next = plan.items.find((it) => it.measurement === null);
    if (item.measurement === null && next && next.slot !== slot) {
      localFail(`Slot ${slot} is out of order; the next tube is slot ${next.slot}.`);
    }
    if (!m || m.sample_type !== item.sample_type) localFail(`Slot ${slot} expects a ${item.sample_type} measurement.`);
    if (item.sample_type === "standard" && m.known_concentration_nM !== item.concentration_nM) {
      localFail(`Slot ${slot} expects ${item.concentration_nM} nM.`);
    }
    if (m.signal !== plan.signal) {
      localFail(`This run measures signal ${plan.signal}, but the page now reads ${m.signal}. Reload the page, or start a new run.`);
    }

    const recorded = { ...m, flags: [...m.flags] };
    if (recorded.config_fingerprint !== plan.config_fingerprint && !recorded.flags.includes("STALE_CONFIG")) {
      recorded.flags.push("STALE_CONFIG");
    }
    item.measurement = recorded;
    localSave(store);
    return plan;
  },

  // ---- Curves --------------------------------------------------------------

  fitCurve(plan_id, excluded_sample_ids) {
    const store = localLoad();
    const plan = store.plans[plan_id];
    if (!plan) localFail(`Run ${plan_id} not found.`);
    const pending = plan.items.filter((it) => it.measurement === null).length;
    if (pending > 0) localFail(`${pending} tube(s) in ${plan_id} are still unread.`);

    const excluded = new Set(excluded_sample_ids ?? []);
    const sampleIds = new Set(plan.items.map((it) => it.measurement.sample_id));
    for (const id of excluded) if (!sampleIds.has(id)) localFail(`Excluded sample ${id} is not in this run.`);

    const included = plan.items.filter((it) => !excluded.has(it.measurement.sample_id));
    const stale = included.filter((it) => it.measurement.config_fingerprint !== plan.config_fingerprint);
    if (stale.length > 0) {
      localFail(`${stale.length} reading(s) were taken under a different config; re-read or exclude them.`);
    }

    const points = included.map((it) => ({
      c: it.sample_type === "blank" ? 0 : it.concentration_nM,
      y: it.measurement.fluorescence,
      sd: it.measurement.fluorescence_sd ?? 0, // manual entries carry no read-noise estimate
    }));
    const blanks = points.filter((pt) => pt.c === 0);
    const standardConcs = [...new Set(points.filter((pt) => pt.c > 0).map((pt) => pt.c))].sort((a, b) => a - b);
    if (blanks.length < 2) localFail("Keep at least 2 blanks: LOD needs a blank SD.");
    if (standardConcs.length < 4) localFail("Keep at least 4 distinct standard concentrations for a 4PL fit.");

    const noise = localNoiseModel(points);
    // No replicate spread and no read-noise estimate to weight by (manual entries, one tube per
    // concentration): fit unweighted, and take the reading variance for the CI from the residuals.
    const unweighted = noise.a === 0 && noise.b === 0 && points.every((pt) => pt.sd === 0);
    const spanScale = Math.max(...points.map((pt) => Math.abs(pt.y)), 1e-12);
    for (const pt of points) {
      const modelSd = Math.sqrt(noise.a + noise.b * pt.y * pt.y);
      pt.sd = unweighted ? 1 : Math.max(pt.sd, modelSd, spanScale * 1e-9);
    }

    const { p, cov } = localFit4PL(points);
    const [top, bottom, lnEc50, hill] = p;
    if (!cov || !cov.flat().every(Number.isFinite)) localFail("Fit did not converge: parameter covariance is undefined.");
    if (!(top > bottom)) localFail("No increasing response: top ≤ bottom, so no curve can be built.");

    const params = { top, bottom, ec50_nM: Math.exp(lnEc50), hill };
    const concentrationAt = (signal) => params.ec50_nM * ((signal - bottom) / (top - signal)) ** (1 / hill);
    const residualSs = points.reduce((acc, pt) => acc + (pt.y - localModel(pt.c, p)) ** 2, 0);
    const readingNoise = unweighted ? { a: residualSs / (points.length - 4), b: 0 } : noise;

    // LOD / LOQ: blank mean + 3 / 10 times the blank SD, then converted to a concentration through the curve.
    const blankYs = blanks.map((pt) => pt.y);
    const blankSd = localSampleSd(blankYs) || (unweighted ? Math.sqrt(readingNoise.a) : localMean(blanks.map((pt) => pt.sd)));
    const blankLevel = Math.max(localMean(blankYs), bottom);
    const lodSignal = blankLevel + 3 * blankSd;
    const loqSignal = blankLevel + 10 * blankSd;
    if (!(loqSignal < top)) localFail("Blank scatter is too large relative to the signal span to define LOD/LOQ.");
    const lod_nM = concentrationAt(lodSignal);
    const loq_nM = concentrationAt(loqSignal);

    // Trusted inversion range: the lower bound is never below the LOD or the lowest standard;
    // the upper bound never exceeds the highest standard, nor 95% of the span (beyond that the curve is too flat).
    const range_nM = {
      min: Math.max(lod_nM, standardConcs[0]),
      max: Math.min(
        standardConcs[standardConcs.length - 1],
        params.ec50_nM * (LOCAL_RANGE_SPAN_FRACTION / (1 - LOCAL_RANGE_SPAN_FRACTION)) ** (1 / hill),
      ),
    };
    if (!(range_nM.min < range_nM.max)) localFail("No usable range: LOD is above the curve's upper limit.");

    const curve = {
      curve_id: localId("CURVE"),
      fitted_at: new Date().toISOString(),
      plan_id: plan.plan_id,
      source: plan.source,
      model: "4PL",
      params,
      lod_nM,
      loq_nM,
      rmse: Math.sqrt(residualSs / points.length),
      range_nM,
      // Reasons are filled in by the page when saveCurve is called; fitCurve's own signature only takes sample ids.
      excluded: [...excluded].map((sample_id) => ({ sample_id, reason: "" })),
      config_fingerprint: plan.config_fingerprint,
      signal: plan.signal,
      conditions: plan.conditions,
    };
    store.drafts[curve.curve_id] = { curve, cov, noise: readingNoise };
    // Keeps only the last 10 drafts, so localStorage doesn't keep growing.
    const draftIds = Object.keys(store.drafts);
    for (const id of draftIds.slice(0, Math.max(0, draftIds.length - 10))) delete store.drafts[id];
    localSave(store);
    return curve;
  },

  // Saves a fitted draft along with its exclusion reasons. A saved curve never changes afterwards:
  // batches refer to it by id, and what they converted has to stay reproducible.
  saveCurve(curve) {
    const store = localLoad();
    if (!curve || !curve.curve_id) localFail("curve_id is required.");
    if (store.curves[curve.curve_id]) localFail(`${curve.curve_id} is already saved.`);

    const draft = store.drafts[curve.curve_id];
    if (!draft) localFail(`Curve ${curve.curve_id} was never fitted.`);
    const reasons = new Map((curve.excluded ?? []).map((e) => [e.sample_id, String(e.reason ?? "").trim()]));
    const draftIds = draft.curve.excluded.map((e) => e.sample_id);
    if (reasons.size !== draftIds.length || !draftIds.every((id) => reasons.has(id))) {
      localFail("Excluded tubes differ from the fit; fit again before saving.");
    }
    const missing = draftIds.filter((id) => !reasons.get(id));
    if (missing.length > 0) localFail(`Give a reason for every excluded tube (${missing.join(", ")}).`);

    const saved = { ...draft.curve, excluded: draftIds.map((id) => ({ sample_id: id, reason: reasons.get(id) })) };
    store.curves[saved.curve_id] = saved;
    store.curve_private[saved.curve_id] = { cov: draft.cov, noise: draft.noise };
    delete store.drafts[saved.curve_id];
    localSave(store);
    return saved;
  },

  listCurves() {
    return Object.values(localLoad().curves).sort((a, b) => b.fitted_at.localeCompare(a.fitted_at));
  },

  getCurve(curve_id) {
    const curve = localLoad().curves[curve_id];
    if (!curve) localFail(`Curve ${curve_id} not found.`);
    return curve;
  },

  // ---- Measurement batches ---------------------------------------------------
  // One sitting at the instrument: the curve is chosen once, blanks are read first, then each
  // sample in replicate tubes. Every tube is stored the moment it is read — it is already spent —
  // and each sample's estimate is the mean of its tubes converted once.

  createBatch(input, configFingerprint, signal) {
    const store = localLoad();
    const curve = store.curves[input?.curve_id];
    if (!curve) localFail("Choose a saved curve.");
    if (!configFingerprint) localFail("The instrument is unreachable, so its config can't be checked against the curve.");
    if (curve.config_fingerprint !== configFingerprint) {
      localFail(`${curve.curve_id} was fitted under config ${curve.config_fingerprint}; the instrument now runs ${configFingerprint}.`);
    }
    if (curve.signal !== signal) localFail(`${curve.curve_id} was fitted on signal ${curve.signal}; readings are now ${signal}.`);
    const tubes = Number(input?.tubes_per_sample);
    if (!(Number.isInteger(tubes) && tubes >= 1 && tubes <= 10)) localFail("Tubes per sample must be an integer from 1 to 10.");
    const notes = String(input?.notes ?? "").trim();
    if (notes.length > LOCAL_TEXT_LIMIT * 5) localFail("Notes are too long.");
    localMakeRoomForBatch(store);

    const batch = {
      batch_id: localId("BATCH"),
      created_at: new Date().toISOString(),
      finished_at: null,
      exported_at: null,
      curve_id: curve.curve_id,
      curve: localCurveSnapshot(curve),
      tubes_per_sample: tubes,
      notes,
      blanks: [],
      blank_estimate: null,
      samples: [],
    };
    localRecomputeBatch(store, batch);
    store.batches[batch.batch_id] = batch;
    localSave(store);
    return batch;
  },

  getBatch(batch_id) {
    const batch = localLoad().batches[batch_id];
    if (!batch) localFail(`Batch ${batch_id} not found.`);
    return batch;
  },

  listBatches() {
    return Object.values(localLoad().batches)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(localBatchSummary);
  },

  // role "blank" adds to the batch's blanks; role "sample" adds a tube to the named sample,
  // creating it on its first tube.
  recordBatchReading(batch_id, role, sample_name, m) {
    const store = localLoad();
    const batch = store.batches[batch_id];
    if (!batch) localFail(`Batch ${batch_id} not found.`);
    if (batch.finished_at) localFail(`${batch_id} is finished; start a new batch to read more.`);
    const expected = role === "blank" ? "blank" : role === "sample" ? "unknown" : null;
    if (!expected) localFail(`Unknown role "${role}".`);
    if (!m || m.sample_type !== expected) localFail(`A ${role} tube must be read as ${expected}.`);

    // The tube is spent, so it is kept even when it can't count: left out, saying why.
    let excluded_reason = null;
    if (m.config_fingerprint !== batch.curve.config_fingerprint) {
      excluded_reason = `Read under config ${m.config_fingerprint}, not the curve's ${batch.curve.config_fingerprint}.`;
    } else if (m.signal !== batch.curve.signal) {
      excluded_reason = `Signal ${m.signal}, not the curve's ${batch.curve.signal}.`;
    }
    const tube = { measurement: { ...m, flags: [...m.flags] }, excluded_reason };
    if (excluded_reason && !tube.measurement.flags.includes("STALE_CONFIG")) tube.measurement.flags.push("STALE_CONFIG");

    if (role === "blank") {
      batch.blanks.push(tube);
    } else {
      const name = String(sample_name ?? "").trim();
      if (!name) localFail("Enter the sample name.");
      if (name.length > LOCAL_TEXT_LIMIT) localFail("The sample name is too long.");
      let sample = batch.samples.find((s) => s.name === name);
      if (!sample) {
        sample = { name, tubes: [], estimate: null };
        batch.samples.push(sample);
      }
      sample.tubes.push(tube);
    }
    localRecomputeBatch(store, batch);
    batch.exported_at = null; // what was exported no longer holds everything
    localSave(store);
    return batch;
  },

  // reason null puts a tube back; a string leaves it out. A tube left out automatically (wrong
  // config or signal) can't be put back.
  setBatchTubeExclusion(batch_id, sample_id, reason) {
    const store = localLoad();
    const batch = store.batches[batch_id];
    if (!batch) localFail(`Batch ${batch_id} not found.`);
    if (batch.finished_at) localFail(`${batch_id} is finished; its tubes can't change.`);
    const tube = localFindTube(batch, sample_id);
    if (!tube) localFail(`Tube ${sample_id} is not in this batch.`);
    const m = tube.measurement;
    const automatic = m.config_fingerprint !== batch.curve.config_fingerprint || m.signal !== batch.curve.signal;
    if (automatic) localFail(`${sample_id} was read under a different config or signal and can't be included.`);
    if (reason === null) {
      tube.excluded_reason = null;
    } else {
      const text = String(reason).trim();
      if (!text) localFail("Give a reason for leaving the tube out.");
      tube.excluded_reason = text;
    }
    localRecomputeBatch(store, batch);
    batch.exported_at = null;
    localSave(store);
    return batch;
  },

  finishBatch(batch_id) {
    const store = localLoad();
    const batch = store.batches[batch_id];
    if (!batch) localFail(`Batch ${batch_id} not found.`);
    if (!batch.finished_at) batch.finished_at = new Date().toISOString();
    localSave(store);
    return batch;
  },

  // Called once the rows have been handed to the browser as a file, so the pages can say which
  // batches still exist nowhere but here.
  markBatchesExported(batch_ids) {
    const store = localLoad();
    const at = new Date().toISOString();
    for (const id of batch_ids ?? []) if (store.batches[id]) store.batches[id].exported_at = at;
    localSave(store);
  },

  // ---- Reset ----------------------------------------------------------------

  // What resetAll() would remove, so the page can show it before anything is deleted. `keys` counts
  // what is in browser storage; the memory copy is counted separately because it is all there is
  // when storage is unavailable (private mode), and a reset has to clear it either way.
  resetPreview() {
    const store = localLoad();
    let keys = 0;
    try {
      keys = localStoredKeys().length;
    } catch (err) {
      // Storage is unavailable, so nothing is persisted; only the memory copy can hold data.
    }
    const batches = Object.values(store.batches);
    return {
      runs: Object.keys(store.plans).length,
      curves: Object.keys(store.curves).length,
      batches: batches.length,
      unexported_batches: batches.filter((batch) => !batch.exported_at).length,
      keys,
      in_memory: localMemoryStore !== null,
    };
  },

  // Deletes everything this software stores in the browser and restores the defaults. Irreversible,
  // and only ever called after the page has had the user confirm. It re-reads storage afterwards
  // and reports what is still there instead of assuming removeItem worked: a delete that silently
  // failed and said "done" is the worst outcome this feature can have.
  resetAll() {
    // The memory copy first: localLoad() would otherwise hand it back the moment storage is empty.
    localMemoryStore = null;

    let storageUnavailable = false;
    let removed = [];
    let remaining = [];
    try {
      removed = localStoredKeys();
      for (const key of removed) localStorage.removeItem(key);
      remaining = localStoredKeys();
    } catch (err) {
      storageUnavailable = true;
    }
    return { removed, remaining, storage_unavailable: storageUnavailable };
  },

  // ---- Backup -------------------------------------------------------------

  // Everything this browser holds, in one file: a curve is meaningless without the run it was
  // fitted from, and a batch without the curve that converted it.
  //
  // blank_scatter is left out on purpose. It is not data but derived state — the scatter of the
  // last blank read — and the next blank re-establishes it. Restoring a stale one from another
  // machine or another session would start flagging perfectly good samples as HIGH_SCATTER.
  exportBackup() {
    const store = localLoad();
    return {
      format: LOCAL_BACKUP_FORMAT,
      version: LOCAL_BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      plans: Object.values(store.plans).sort((a, b) => b.created_at.localeCompare(a.created_at)),
      curves: Object.values(store.curves)
        .sort((a, b) => b.fitted_at.localeCompare(a.fitted_at))
        // curve_private rides along: the covariance and noise model are not part of the data
        // contract, but without them a restored curve can't convert anything.
        .map((curve) => ({ ...curve, private: store.curve_private[curve.curve_id] ?? null })),
      batches: Object.values(store.batches).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    };
  },

  // Restores a backup. The file is untrusted throughout, so every entry is validated before it is
  // stored. Sections are independent: one bad curve must not cost you the runs in the same file.
  importBackup(payload) {
    if (!payload || typeof payload !== "object" || payload.format !== LOCAL_BACKUP_FORMAT) {
      localFail("That file is not a LasReader backup.");
    }
    // A missing version is a malformed file, not a newer one; saying "newer" would send the user
    // looking for a build that doesn't exist.
    if (!Number.isInteger(payload.version)) localFail("That file carries no version number.");
    if (payload.version > LOCAL_BACKUP_VERSION) localFail(`That file is version ${payload.version}, newer than this build understands.`);
    if (payload.version < LOCAL_BACKUP_VERSION) {
      localFail(`That file is version ${payload.version}, from the earlier workflow. Its runs carry no biosensor or induction time, so this build can't use them.`);
    }

    const plans = Array.isArray(payload.plans) ? payload.plans : [];
    const curves = Array.isArray(payload.curves) ? payload.curves : [];
    const batches = Array.isArray(payload.batches) ? payload.batches : [];
    if (!plans.length && !curves.length && !batches.length) localFail("That file holds nothing to restore.");

    const store = localLoad();
    const result = {
      plans: localImportSection(plans, "plan_id", localPlanProblem, (id) => Boolean(store.plans[id]), (entry) => {
        // Slot order is what the run walks through, and a hand-edited file could have reordered it.
        store.plans[entry.plan_id] = { ...entry, items: [...entry.items].sort((a, b) => a.slot - b.slot) };
      }),
      curves: localImportSection(curves, "curve_id", localCurveProblem, (id) => Boolean(store.curves[id]), (entry) => {
        const { private: priv, ...curve } = entry;
        store.curves[curve.curve_id] = curve;
        store.curve_private[curve.curve_id] = { cov: priv.cov, noise: priv.noise };
      }),
      batches: localImportSection(batches, "batch_id", localBatchProblem, (id) => Boolean(store.batches[id]), (entry) => {
        store.batches[entry.batch_id] = entry;
      }),
    };
    localSave(store);
    return result;
  },
};
