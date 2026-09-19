// =========================================================
// CAPTURE-Screen's temporary stand-in backend: calibration plan / curve storage, weighted
// 4PL fitting (Levenberg-Marquardt), LOD/LOQ, concentration inversion with a 95% CI
// (delta method), and the QC flags that need stored state to determine.
//
// The device only takes readings (via the backend's POST /api/hardware/read); the backend
// has no plan/curve storage or fitting yet, so this lives in the browser's localStorage for
// now (falling back to memory if reads/writes fail). Once the backend has storage, this
// whole file gets replaced by HTTP calls.
//
// Holds only Measurements converted from a mode "measurement" reading, or readings recorded
// earlier and entered by hand (source "manual"); live-stream data never can and never should reach this.
//
// Pages never call this directly — only through js/hardware_api.js.
// =========================================================

// Upper bound on the inversion range: past 95% of the 4PL span the curve is too flat, and inversion error blows up.
const LOCAL_RANGE_SPAN_FRACTION = 0.95;
// How many Measure readings the log keeps. It has to be capped: localSave() swallows a
// QuotaExceededError, so a log left to grow would eventually fill the origin's storage quota and
// silently stop plans and curves persisting too — not just itself. A reading is ~600 bytes, so
// this is well under any browser's budget, and a CSV export is the copy that actually lasts.
const LOCAL_MEASUREMENT_LIMIT = 500;
// The curve export file's shape. Named inside the file so an import can tell one of ours from any
// other JSON, and versioned so a build that predates a format change refuses it instead of
// guessing. Both the writer and the reader live here, so the two can't drift apart.
const LOCAL_CURVES_EXPORT_FORMAT = "lasreader.hardware.curves";
const LOCAL_CURVES_EXPORT_VERSION = 1;
// Calibration runs get their own file: they are the raw readings a curve was fitted from, and
// losing them means the fit can never be redone or checked, only trusted.
const LOCAL_PLANS_EXPORT_FORMAT = "lasreader.hardware.plans";
const LOCAL_PLANS_EXPORT_VERSION = 1;
// One file holding everything, so a restore can't quietly bring back half of it. Curves and runs
// used to be exported separately, and it took only forgetting one file to end up with a curve
// whose calibration data was gone; importBackup() still reads those older single-section files.
const LOCAL_BACKUP_FORMAT = "lasreader.hardware.backup";
const LOCAL_BACKUP_VERSION = 1;
const LOCAL_STORE_KEY = "lasreader.hardware.local.v2";
// Everything before v2 came from the now-removed simulated device: clear it on load so
// simulated plans, curves, and dark-read records never mix in with real measurements.
const LOCAL_LEGACY_KEYS = [
  "lasreader.hardware.local.v1",
  "lasreader.hardware.mock.v1",
  "lasreader.hardware.mockDevice.v1",
  "lasreader.hardware.lastPlanId",
  "lasreader.hardware.lastDarkReadUtc",
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
    curves: {},        // curve_id -> CalibrationCurve: saved
    curve_private: {}, // curve_id -> { cov, noise }: needed for inversion CI, but not part of the data contract
    blank_scatter: {}, // config fingerprint -> scatter of the most recent passing blank (the HIGH_SCATTER baseline)
    measurements: [],  // the Measure page's reading log, oldest first, capped at LOCAL_MEASUREMENT_LIMIT
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

// Fluorescence -> concentration. Only gives a point estimate within the curve's trusted range; outside it, only status comes back, never an extrapolation.
function localInverseCore(F, curve, priv) {
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

// ---- Importing into a store -----------------------------------------------
// One implementation per section, taking the store so a combined backup can restore all three in
// a single load/save. Each section is independent: a rejected curve must not cost you the runs in
// the same file. Everything here follows the same two rules — an id already stored is kept rather
// than replaced (what is here was produced on this machine; the file is a copy of something older),
// and whatever fails validation is reported with a reason instead of vanishing.

function localImportPlansInto(store, entries) {
  const imported = [];
  const skipped = [];
  const rejected = [];
  for (const entry of entries) {
    const plan_id = typeof entry?.plan_id === "string" && entry.plan_id.trim() ? entry.plan_id : "(no plan_id)";
    const problem = localPlanProblem(entry);
    if (problem) {
      rejected.push({ id: plan_id, reason: problem });
    } else if (store.plans[entry.plan_id]) {
      skipped.push(entry.plan_id);
    } else {
      // Slot order is what the run walks through, and a hand-edited file could have reordered it.
      store.plans[entry.plan_id] = { ...entry, items: [...entry.items].sort((a, b) => a.slot - b.slot) };
      imported.push(entry.plan_id);
    }
  }
  return { imported, skipped, rejected };
}

function localImportCurvesInto(store, entries) {
  const imported = [];
  const skipped = [];
  const rejected = [];
  for (const entry of entries) {
    const curve_id = typeof entry?.curve_id === "string" && entry.curve_id.trim() ? entry.curve_id : "(no curve_id)";
    const problem = localCurveProblem(entry);
    if (problem) {
      rejected.push({ id: curve_id, reason: problem });
    } else if (store.curves[entry.curve_id]) {
      skipped.push(entry.curve_id);
    } else {
      const { private: priv, ...curve } = entry;
      // is_active is always cleared: making a curve active has to go through saveCurve()'s check
      // against the config the instrument is running right now.
      store.curves[curve.curve_id] = { ...curve, is_active: false };
      store.curve_private[curve.curve_id] = { cov: priv.cov, noise: priv.noise };
      imported.push(curve.curve_id);
    }
  }
  return { imported, skipped, rejected };
}

function localImportMeasurementsInto(store, entries) {
  const existing = new Set(store.measurements.map((record) => record.record_id));
  const imported = [];
  const skipped = [];
  const rejected = [];
  for (const entry of entries) {
    const record_id = typeof entry?.record_id === "string" && entry.record_id.trim() ? entry.record_id : "(no record_id)";
    const problem = localMeasurementRecordProblem(entry);
    if (problem) {
      rejected.push({ id: record_id, reason: problem });
    } else if (existing.has(entry.record_id)) {
      skipped.push(entry.record_id);
    } else {
      store.measurements.push(entry);
      existing.add(entry.record_id);
      imported.push(entry.record_id);
    }
  }
  // Back into time order before capping: an import can easily push the log past the limit, and
  // what survives has to be the newest readings, not whatever order the file happened to hold.
  // The count that fell off is returned rather than swallowed — this is the one place an import
  // can lose a reading that was already here.
  store.measurements.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const dropped = Math.max(0, store.measurements.length - LOCAL_MEASUREMENT_LIMIT);
  if (dropped > 0) store.measurements = store.measurements.slice(-LOCAL_MEASUREMENT_LIMIT);
  return { imported, skipped, rejected, dropped };
}

// One stored reading out of an import file. item is the plan slot it claims to fill, or null for a
// standalone Measure record. A plan is what fitCurve() reads, so anything wrong here ends up
// inside a curve, and then inside every reading that curve converts.
function localMeasurementProblem(m, item) {
  const finite = (value) => Number.isFinite(value);
  const nullOrFinite = (value) => value === null || finite(value);
  if (!m || typeof m !== "object") return "measurement is not an object";
  if (typeof m.sample_id !== "string" || !m.sample_id.trim()) return "measurement.sample_id is missing";
  if (typeof m.timestamp_utc !== "string" || Number.isNaN(Date.parse(m.timestamp_utc))) {
    return "measurement.timestamp_utc is not a date";
  }
  if (item) {
    if (m.sample_type !== item.sample_type) {
      return `measurement.sample_type "${m.sample_type}" is not the slot's "${item.sample_type}"`;
    }
    if (item.sample_type === "standard" && m.known_concentration_nM !== item.concentration_nM) {
      return "measurement.known_concentration_nM does not match the slot";
    }
  } else {
    // A Measure record has no slot to agree with, so the type and its concentration are checked
    // against each other instead: only a standard knows what it should read.
    if (!["blank", "standard", "unknown"].includes(m.sample_type)) {
      return `unknown measurement.sample_type "${m.sample_type}"`;
    }
    if (m.sample_type === "standard") {
      if (!(finite(m.known_concentration_nM) && m.known_concentration_nM >= 0)) {
        return "a standard needs known_concentration_nM ≥ 0";
      }
    } else if (m.known_concentration_nM !== null) {
      return "only a standard may carry known_concentration_nM";
    }
  }
  if (!finite(m.fluorescence)) return "measurement.fluorescence is not a number";
  // Null on both: a manual entry records neither read noise nor scatter.
  if (!nullOrFinite(m.fluorescence_sd)) return "measurement.fluorescence_sd is neither a number nor null";
  if (!nullOrFinite(m.scatter)) return "measurement.scatter is neither a number nor null";
  if (!Array.isArray(m.flags) || !m.flags.every((flag) => typeof flag === "string")) return "measurement.flags is malformed";
  if (!/^[0-9a-f]{6}$/.test(String(m.config_fingerprint))) return "measurement.config_fingerprint is malformed";
  if (!["device", "manual"].includes(m.source)) return `unknown measurement.source "${m.source}"`;
  // raw is only ever displayed and exported, never computed from, so it is checked loosely:
  // the fit reads fluorescence alone.
  if (m.raw !== null) {
    if (!m.raw || typeof m.raw !== "object") return "measurement.raw is neither an object nor null";
    if (!Object.values(m.raw).every(finite)) return "measurement.raw holds a non-number";
  }
  return null;
}

// One calibration run out of an import file: an error message, or null if it is sound.
function localPlanProblem(entry) {
  if (!entry || typeof entry !== "object") return "not an object";
  if (typeof entry.plan_id !== "string" || !entry.plan_id.trim()) return "plan_id is missing";
  if (typeof entry.created_at !== "string" || Number.isNaN(Date.parse(entry.created_at))) return "created_at is not a date";
  if (!["device", "manual"].includes(entry.source)) return `unknown source "${entry.source}"`;
  if (entry.measured_on !== null && !localIsPastDate(entry.measured_on)) return "measured_on is neither a past date nor null";
  if (!/^[0-9a-f]{6}$/.test(String(entry.config_fingerprint))) return "config_fingerprint is malformed";
  if (typeof entry.timepoint !== "string" || !entry.timepoint.trim()) return "timepoint is missing";
  if (!Array.isArray(entry.items) || entry.items.length === 0) return "items is missing";

  const slots = new Set();
  for (const item of entry.items) {
    if (!item || typeof item !== "object") return "an item is not an object";
    if (!Number.isInteger(item.slot) || item.slot < 1) return "an item has a bad slot number";
    // Duplicate slots would make targetItem() and recordPlanMeasurement() disagree about which
    // tube is next, and the run would never finish.
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
      const problem = localMeasurementProblem(item.measurement, item);
      if (problem) return `slot ${item.slot}: ${problem}`;
    }
  }
  // A manual dataset is defined by having every slot already filled, and recordPlanMeasurement()
  // refuses to fill one, so a gap here would be a run that can never be completed.
  if (entry.source === "manual" && entry.items.some((item) => item.measurement === null)) {
    return "a manual dataset cannot have an unread slot";
  }
  return null;
}

// One Measure reading-log entry out of an import file. The estimate is checked as strictly as the
// measurement: a restored row that claims a concentration outside the "ok" status would read as a
// result the curve never gave.
function localMeasurementRecordProblem(entry) {
  const finite = (value) => Number.isFinite(value);
  const isDate = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
  if (!entry || typeof entry !== "object") return "not an object";
  if (typeof entry.record_id !== "string" || !entry.record_id.trim()) return "record_id is missing";
  if (!isDate(entry.recorded_at)) return "recorded_at is not a date";
  if (!(entry.exported_at === null || isDate(entry.exported_at))) return "exported_at is neither a date nor null";

  const problem = localMeasurementProblem(entry.measurement, null);
  if (problem) return problem;

  const estimate = entry.estimate;
  if (!estimate || typeof estimate !== "object") return "estimate is missing";
  if (!["ok", "below_lod", "above_range", "no_curve", "config_mismatch"].includes(estimate.status)) {
    return `unknown estimate.status "${estimate.status}"`;
  }
  if (estimate.status === "ok") {
    if (!finite(estimate.concentration_nM)) return "estimate.concentration_nM is not a number";
    if (!Array.isArray(estimate.ci95_nM) || estimate.ci95_nM.length !== 2 || !estimate.ci95_nM.every(finite)) {
      return "estimate.ci95_nM is malformed";
    }
  } else if (estimate.concentration_nM !== null) {
    return 'only an "ok" estimate may carry a concentration';
  }
  if (!(estimate.curve_id === null || typeof estimate.curve_id === "string")) {
    return "estimate.curve_id is neither a string nor null";
  }

  if (entry.curve !== null) {
    const curve = entry.curve;
    if (!curve || typeof curve !== "object") return "curve snapshot is neither an object nor null";
    if (typeof curve.curve_id !== "string" || !curve.curve_id.trim()) return "curve snapshot: curve_id is missing";
    if (typeof curve.timepoint !== "string") return "curve snapshot: timepoint is missing";
    if (!finite(curve.lod_nM)) return "curve snapshot: lod_nM is not a number";
    if (!curve.range_nM || !finite(curve.range_nM.min) || !finite(curve.range_nM.max)) {
      return "curve snapshot: range_nM is malformed";
    }
  }
  return null;
}

// One curve out of an import file: an error message naming what is wrong, or null if it is sound.
// A curve that gets past this will convert real readings into concentrations, so every field a
// later calculation touches is checked here rather than trusted. is_active is deliberately not
// checked: localImportCurvesInto() overrides it either way.
function localCurveProblem(entry) {
  const finite = (value) => Number.isFinite(value);
  if (!entry || typeof entry !== "object") return "not an object";
  if (typeof entry.curve_id !== "string" || !entry.curve_id.trim()) return "curve_id is missing";
  if (entry.model !== "4PL") return `unsupported model "${entry.model}"`;
  if (typeof entry.fitted_at !== "string" || Number.isNaN(Date.parse(entry.fitted_at))) return "fitted_at is not a date";
  if (!/^[0-9a-f]{6}$/.test(String(entry.config_fingerprint))) return "config_fingerprint is malformed";
  if (typeof entry.timepoint !== "string" || !entry.timepoint.trim()) return "timepoint is missing";
  if (entry.source !== undefined && !["device", "manual"].includes(entry.source)) return `unknown source "${entry.source}"`;

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
  // its confidence interval — the first inversion would throw.
  const priv = entry.private;
  if (!priv || typeof priv !== "object") return "fit internals are missing";
  if (!priv.noise || !finite(priv.noise.a) || !finite(priv.noise.b)) return "fit internals: the noise model is malformed";
  if (!Array.isArray(priv.cov) || priv.cov.length !== 4) return "fit internals: the covariance is not 4x4";
  for (const row of priv.cov) {
    if (!Array.isArray(row) || row.length !== 4 || !row.every(finite)) return "fit internals: the covariance is not 4x4";
  }
  return null;
}

// ---- Exposed to hardware_api.js -----------------------------------------

const HardwareLocal = {
  // HIGH_SCATTER needs "the most recent blank under the same config" as its baseline.
  measurementContext(configFingerprint) {
    const value = localLoad().blank_scatter[configFingerprint];
    return { blankScatter: Number.isFinite(value) ? value : null };
  },

  // Called right after HardwareProcessing.toMeasurement() has assembled a reading:
  // adds the flags that need stored state, and updates the blank baseline. Only sample reads go
  // through here (Measure and a calibration run); the status page's instrument check goes through
  // HardwareApi.runBlankCheck(), which skips this entirely.
  finalizeMeasurement(m) {
    const store = localLoad();

    // The HIGH_SCATTER baseline, and so what counts as "too cloudy", is whatever blank was read
    // last. That must be a calibration blank — cells at the standards' OD, no AHL. A buffer-only
    // cuvette would set it far below any real sample and flag everything read after it.
    if (m.sample_type === "blank" && !m.flags.some((f) => ["HIGH_SCATTER", "NO_DARK_PAIR", "SATURATED"].includes(f))) {
      store.blank_scatter[m.config_fingerprint] = m.scatter;
    }

    // QC for unknowns: compared against the active curve, using exactly the same rule as invert().
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
      plan_id: localId("PLAN"),
      created_at: new Date().toISOString(),
      source: "device",
      measured_on: null,
      config_fingerprint: configFingerprint,
      timepoint: String(timepoint).trim(),
      items: items.map((item, i) => ({ slot: i + 1, ...item, measurement: null })),
    };
    store.plans[plan.plan_id] = plan;
    localSave(store);
    return plan;
  },

  // Readings recorded earlier and entered by hand, stored as a plan whose every slot is already
  // filled, so fitting, exclusions, and saving run exactly as they do for a device run. Slots
  // keep the order the rows were entered in. Nothing that wasn't recorded (read-noise SD,
  // scatter, channels) is filled in: those fields stay null.
  createManualDataset(input, configFingerprint) {
    const store = localLoad();
    const { timepoint, measured_on, rows } = input ?? {};
    if (!/^[0-9a-f]{6}$/.test(String(configFingerprint))) localFail("Instrument config unknown: a dataset must be bound to a config.");
    if (!timepoint || !String(timepoint).trim()) localFail("Describe the timepoint.");
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

    const plan_id = localId("PLAN");
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
      timepoint: String(timepoint).trim(),
      items,
    };
    store.plans[plan_id] = plan;
    localSave(store);
    return plan;
  },

  getCalibrationPlan(plan_id) {
    const plan = localLoad().plans[plan_id];
    if (!plan) localFail(`Plan ${plan_id} not found.`);
    return plan;
  },

  // Newest first. Only what a list needs, so a page doesn't have to hold every reading in memory
  // to show a row per run.
  listCalibrationPlans() {
    return Object.values(localLoad().plans)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((plan) => ({
        plan_id: plan.plan_id,
        created_at: plan.created_at,
        source: plan.source,
        measured_on: plan.measured_on,
        config_fingerprint: plan.config_fingerprint,
        timepoint: plan.timepoint,
        total: plan.items.length,
        read: plan.items.filter((item) => item.measurement !== null).length,
      }));
  },


  recordPlanMeasurement(plan_id, slot, m) {
    const store = localLoad();
    const plan = store.plans[plan_id];
    if (!plan) localFail(`Plan ${plan_id} not found.`);
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

    const rmse = Math.sqrt(residualSs / points.length);

    const curve = {
      curve_id: localId("CURVE"),
      fitted_at: new Date().toISOString(),
      source: plan.source === "manual" ? "manual" : "device",
      model: "4PL",
      params,
      lod_nM,
      loq_nM,
      rmse,
      range_nM,
      // Reasons are filled in by the page when saveCurve is called; fitCurve's own signature only takes sample ids.
      excluded: [...excluded].map((sample_id) => ({ sample_id, reason: "" })),
      config_fingerprint: plan.config_fingerprint,
      timepoint: plan.timepoint,
      is_active: false,
    };
    store.drafts[curve.curve_id] = { curve, cov, noise: readingNoise };
    // Keeps only the last 10 drafts, so localStorage doesn't keep growing.
    const draftIds = Object.keys(store.drafts);
    for (const id of draftIds.slice(0, Math.max(0, draftIds.length - 10))) delete store.drafts[id];
    localSave(store);
    return curve;
  },

  // A new curve (draft): saved along with its exclusion reasons. An existing curve: only
  // accepts toggling is_active, and its parameters always defer to the stored version.
  // currentFingerprint is the device's current config, used to confirm the curve still
  // applies when setting it active; it's null when the device is unreachable, in which case
  // setting active is not allowed.
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

  // ---- The Measure page's reading log -------------------------------------
  // Measure otherwise shows one reading and then overwrites it, which is no way to keep data that
  // took a wet-lab run to produce. This is the working copy only: a browser's storage is one
  // "clear site data" away from empty, so a CSV export is what actually preserves a reading.

  // The estimate is stored as it was reported, never recomputed later: the active curve can be
  // swapped, restricted or deleted afterwards, and the record has to keep the number that was
  // actually read off the screen together with the curve it came from. The same goes for the
  // curve's own limits, so an exported row can be read without still having the curve.
  recordMeasurement(m, estimate, curve) {
    const store = localLoad();
    const record = {
      record_id: localId("READ"),
      recorded_at: new Date().toISOString(),
      measurement: m,
      estimate,
      curve: curve
        ? { curve_id: curve.curve_id, timepoint: curve.timepoint, lod_nM: curve.lod_nM, range_nM: curve.range_nM }
        : null,
      exported_at: null,
    };
    store.measurements.push(record);
    // Drops the oldest, which is why the page keeps the unexported count in front of the user.
    if (store.measurements.length > LOCAL_MEASUREMENT_LIMIT) {
      store.measurements = store.measurements.slice(-LOCAL_MEASUREMENT_LIMIT);
    }
    localSave(store);
    return record;
  },

  listMeasurements() {
    return localLoad().measurements;
  },

  // Called once the rows have been handed to the browser as a file, so the page can keep saying
  // how many readings still exist nowhere but here.
  markMeasurementsExported(record_ids) {
    const store = localLoad();
    const ids = new Set(record_ids ?? []);
    const at = new Date().toISOString();
    for (const record of store.measurements) {
      if (ids.has(record.record_id)) record.exported_at = at;
    }
    localSave(store);
    return store.measurements;
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
    return {
      runs: Object.keys(store.plans).length,
      curves: Object.keys(store.curves).length,
      readings: store.measurements.length,
      unexported_readings: store.measurements.filter((record) => !record.exported_at).length,
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

  // Everything this browser holds, in one file. Deliberately one file and not three: a curve is
  // meaningless without the run it was fitted from, and it took only forgetting one of two
  // downloads to end up with exactly that.
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
        // contract, but without them a restored curve inverts and never gives a interval.
        .map((curve) => ({ ...curve, private: store.curve_private[curve.curve_id] ?? null })),
      measurements: [...store.measurements],
    };
  },

  // Restores a backup. The file is untrusted throughout — hand-edited, from another build, or not
  // ours at all — so every entry is validated before it is stored. Sections are independent: one
  // bad curve must not cost you the runs in the same file. A section missing from the file comes
  // back as null, which is not the same as one that was present and empty.
  importBackup(payload) {
    if (!payload || typeof payload !== "object") localFail("That file is not a LasReader backup.");

    // Curves and runs were exported separately before the combined backup existed; those files
    // still restore, so an earlier download never becomes unreadable.
    const legacy = {
      [LOCAL_CURVES_EXPORT_FORMAT]: { key: "curves", max: LOCAL_CURVES_EXPORT_VERSION },
      [LOCAL_PLANS_EXPORT_FORMAT]: { key: "plans", max: LOCAL_PLANS_EXPORT_VERSION },
    }[payload.format];
    const { key, max } = legacy ?? { key: null, max: LOCAL_BACKUP_VERSION };
    if (!legacy && payload.format !== LOCAL_BACKUP_FORMAT) localFail("That file is not a LasReader backup.");

    // A missing version is a malformed file, not a newer one; saying "newer" would send the user
    // looking for a build that doesn't exist.
    if (!Number.isInteger(payload.version)) localFail("That file carries no version number.");
    if (payload.version > max) localFail(`That file is version ${payload.version}, newer than this build understands.`);

    const section = (name) => (key === null || key === name) && Array.isArray(payload[name]) ? payload[name] : null;
    const plans = section("plans");
    const curves = section("curves");
    const measurements = section("measurements");
    if (!plans?.length && !curves?.length && !measurements?.length) localFail("That file holds nothing to restore.");

    const store = localLoad();
    const result = {
      plans: plans ? localImportPlansInto(store, plans) : null,
      curves: curves ? localImportCurvesInto(store, curves) : null,
      measurements: measurements ? localImportMeasurementsInto(store, measurements) : null,
    };
    localSave(store);
    return result;
  },
};
