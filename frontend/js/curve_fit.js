// =========================================================
// The 4PL standard-curve model shared by both tools: weighted 4PL fitting (Levenberg-Marquardt),
// LOD/LOQ, the usable range, and inversion with a 95% CI (delta method). CAPTURE-Screen's
// calibration (js/hardware_local.js) and the Plate Reader Assay (js/plate_assay.js) both call it,
// so the same readings give the same curve on either page. docs/capture_screen_model.md §7–11
// describes it step by step; change a formula here and the matching section there in one change.
//
// Pure functions only: no DOM, storage, fetch, or clock.
// =========================================================

// Upper bound on the inversion range: past 95% of the 4PL span the curve is too flat, and inversion error blows up.
const CURVE_RANGE_SPAN_FRACTION = 0.95;

function curveMean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function curveSampleSd(values) {
  if (values.length < 2) return 0;
  const m = curveMean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

// ---- 4PL -------------------------------------------------------------

// The parameter vector during fitting is [top, bottom, ln(ec50_nM), hill]: using ln(EC50)
// keeps LM stepping on a log scale and stops EC50 from ever being pushed negative.
function curveModel(c, p) {
  if (c <= 0) return p[1];
  const u = Math.exp(p[3] * (p[2] - Math.log(c)));
  return p[1] + (p[0] - p[1]) / (1 + u);
}

function curveGradient(c, p) {
  if (c <= 0) return [0, 1, 0, 0];
  const lnRatio = p[2] - Math.log(c);
  const s = 1 / (1 + Math.exp(p[3] * lnRatio)); // still safe when u overflows to Infinity, giving s = 0
  const span = p[0] - p[1];
  const ds = s * (1 - s); // = u / (1 + u)^2, more numerically stable than computing it directly
  return [s, 1 - s, -span * ds * p[3], -span * ds * lnRatio];
}

// ---- Linear algebra (4x4 is enough) ---------------------------------------

function curveSolve(matrix, rhs) {
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

function curveInverse(matrix) {
  const n = matrix.length;
  const columns = [];
  for (let j = 0; j < n; j++) {
    const e = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
    const col = curveSolve(matrix, e);
    if (!col) return null;
    columns.push(col);
  }
  return Array.from({ length: n }, (_, i) => columns.map((col) => col[i]));
}

// ---- Fitting ------------------------------------------------------------

function curveGroupByConcentration(points) {
  const groups = new Map();
  for (const pt of points) {
    if (!groups.has(pt.c)) groups.set(pt.c, []);
    groups.get(pt.c).push(pt.y);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([c, ys]) => ({ c, ys, mean: curveMean(ys) }));
}

// Variance model for a single reading, var(F) = a + b*F^2 (additive + proportional noise),
// estimated from the actual spread across replicates. Used both for fit weights and for inversion CI.
function curveNoiseModel(points) {
  const groups = curveGroupByConcentration(points).filter((g) => g.ys.length >= 2);
  if (groups.length === 0) {
    return { a: curveMean(points.map((pt) => pt.sd * pt.sd)), b: 0 };
  }
  const xs = groups.map((g) => g.mean * g.mean);
  const vs = groups.map((g) => curveSampleSd(g.ys) ** 2);
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

// Weighted least squares. Each point's standard deviation is the larger of "that reading's own
// read-noise estimate" and "the replicate-spread model": CAPTURE-Screen's fluorescence_sd
// only captures read noise (no shot noise), so using it alone as the weight would let a few
// tubes with an unusually stable dark level get distorted, oversized weight.
function curveFit4PL(points) {
  const groups = curveGroupByConcentration(points);
  const bottom0 = groups[0].mean;
  let top0 = groups[groups.length - 1].mean;
  if (top0 <= bottom0) top0 = bottom0 + Math.abs(bottom0) * 0.01 + 1e-9;
  const mid = (top0 + bottom0) / 2;
  const nonzero = groups.filter((g) => g.c > 0);
  const nearest = nonzero.reduce((best, g) => (Math.abs(g.mean - mid) < Math.abs(best.mean - mid) ? g : best));
  let p = [top0, bottom0, Math.log(nearest.c), 1];

  const cost = (q) => points.reduce((acc, pt) => acc + ((pt.y - curveModel(pt.c, q)) / pt.sd) ** 2, 0);

  const normalEquations = (q) => {
    const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const g = [0, 0, 0, 0];
    for (const pt of points) {
      const w = 1 / (pt.sd * pt.sd);
      const r = pt.y - curveModel(pt.c, q);
      const J = curveGradient(pt.c, q);
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
      const step = curveSolve(damped, g);
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
  const inv = curveInverse(A);
  const dof = points.length - 4;
  const scale = dof > 0 ? current / dof : NaN;
  const cov = inv ? inv.map((row) => row.map((v) => v * scale)) : null;
  return { p, cov };
}

const CurveFit = {
  mean: curveMean,
  sampleSd: curveSampleSd,

  // The 4PL at concentration c for a fit's params ({top, bottom, ec50_nM, hill}).
  model(c, params) {
    return curveModel(c, [params.top, params.bottom, Math.log(params.ec50_nM), params.hill]);
  },

  // points: [{ c, y, sd }], one per reading. c is the concentration in nM, 0 for a blank; sd is the
  // reading's own read-noise estimate, 0 when there is none. The caller's points are not changed.
  // Returns { params, lod_nM, loq_nM, rmse, range_nM, cov, noise }: cov (4x4, over
  // [top, bottom, ln EC50, hill]) and noise ({a, b}) are what invert() needs for the CI.
  // Throws an Error saying why when no usable curve can be built.
  fit(input) {
    const points = input.map((pt) => ({ c: pt.c, y: pt.y, sd: pt.sd }));
    const blanks = points.filter((pt) => pt.c === 0);
    const standardConcs = [...new Set(points.filter((pt) => pt.c > 0).map((pt) => pt.c))].sort((a, b) => a - b);
    if (blanks.length < 2) throw new Error("Keep at least 2 blanks: LOD needs a blank SD.");
    if (standardConcs.length < 4) throw new Error("Keep at least 4 distinct standard concentrations for a 4PL fit.");

    const noise = curveNoiseModel(points);
    // No replicate spread and no read-noise estimate to weight by (one reading per concentration,
    // none with a read-noise SD): fit unweighted, and take the reading variance for the CI from the residuals.
    const unweighted = noise.a === 0 && noise.b === 0 && points.every((pt) => pt.sd === 0);
    const spanScale = Math.max(...points.map((pt) => Math.abs(pt.y)), 1e-12);
    for (const pt of points) {
      const modelSd = Math.sqrt(noise.a + noise.b * pt.y * pt.y);
      pt.sd = unweighted ? 1 : Math.max(pt.sd, modelSd, spanScale * 1e-9);
    }

    const { p, cov } = curveFit4PL(points);
    const [top, bottom, lnEc50, hill] = p;
    if (!cov || !cov.flat().every(Number.isFinite)) throw new Error("Fit didn't converge: parameter covariance is undefined.");
    if (!(top > bottom)) throw new Error("No increasing response: top ≤ bottom, so no curve can be built.");

    const params = { top, bottom, ec50_nM: Math.exp(lnEc50), hill };
    const concentrationAt = (signal) => params.ec50_nM * ((signal - bottom) / (top - signal)) ** (1 / hill);
    const residualSs = points.reduce((acc, pt) => acc + (pt.y - curveModel(pt.c, p)) ** 2, 0);
    const readingNoise = unweighted ? { a: residualSs / (points.length - 4), b: 0 } : noise;

    // LOD / LOQ: blank mean + 3 / 10 times the blank SD, then converted to a concentration through the curve.
    const blankYs = blanks.map((pt) => pt.y);
    const blankSd = curveSampleSd(blankYs) || (unweighted ? Math.sqrt(readingNoise.a) : curveMean(blanks.map((pt) => pt.sd)));
    const blankLevel = Math.max(curveMean(blankYs), bottom);
    const lodSignal = blankLevel + 3 * blankSd;
    const loqSignal = blankLevel + 10 * blankSd;
    if (!(loqSignal < top)) throw new Error("Blank scatter is too large relative to the signal span to define LOD/LOQ.");
    const lod_nM = concentrationAt(lodSignal);
    const loq_nM = concentrationAt(loqSignal);

    // Trusted inversion range: the lower bound is never below the LOD or the lowest standard;
    // the upper bound never exceeds the highest standard, nor 95% of the span (beyond that the curve is too flat).
    const range_nM = {
      min: Math.max(lod_nM, standardConcs[0]),
      max: Math.min(
        standardConcs[standardConcs.length - 1],
        params.ec50_nM * (CURVE_RANGE_SPAN_FRACTION / (1 - CURVE_RANGE_SPAN_FRACTION)) ** (1 / hill),
      ),
    };
    if (!(range_nM.min < range_nM.max)) throw new Error("No usable range: LOD is above the curve's upper limit.");

    return { params, lod_nM, loq_nM, rmse: Math.sqrt(residualSs / points.length), range_nM, cov, noise: readingNoise };
  },

  // Signal -> concentration. Only gives a point estimate within the curve's trusted range; outside
  // it, only status comes back, never an extrapolation. F is the mean of n readings, so the reading's
  // own variance is divided by n; the curve's parameter uncertainty is not, since every reading shares it.
  // fit needs { params, range_nM, cov, noise }.
  invert(F, fit, n = 1) {
    const { top, bottom, ec50_nM, hill } = fit.params;
    if (!(F > bottom)) return { status: "below_lod" };
    if (!(F < top)) return { status: "above_range" };

    const lnRatio = Math.log((F - bottom) / (top - F));
    const lnC = Math.log(ec50_nM) + lnRatio / hill;
    const c = Math.exp(lnC);
    if (c < fit.range_nM.min) return { status: "below_lod" };
    if (c > fit.range_nM.max) return { status: "above_range" };

    // delta method on ln(c): the reading's own variance plus the parameter covariance
    const gF = (1 / hill) * (1 / (F - bottom) + 1 / (top - F));
    const gTheta = [-(1 / hill) / (top - F), -(1 / hill) / (F - bottom), 1, -lnRatio / (hill * hill)];
    let variance = (gF * gF * (fit.noise.a + fit.noise.b * F * F)) / n;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) variance += gTheta[i] * fit.cov[i][j] * gTheta[j];
    }
    const half = 1.96 * Math.sqrt(Math.max(variance, 0));
    return { status: "ok", concentration_nM: c, ci95_nM: [Math.exp(lnC - half), Math.exp(lnC + half)] };
  },
};
