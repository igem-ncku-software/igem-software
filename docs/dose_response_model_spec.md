# Dose-Response Model — Implementation Spec (Spec for Claude Code)

**Project**: Dose-response quantification of the E. coli LasR-AHL biosensor's response to 3-oxo-C12-HSL
**Corresponding experiment**: `[E. coli-LasR-AHL][Time-Course AHL Dose-Response Fluorescence] design v.1 (20260809)`
**Intended audience**: whoever implements this (a person or Claude Code). This document pins down the math, data format, module structure, and tests — implementation just needs to follow it.

> Assumption: implemented in **Python** (numpy / pandas / scipy / lmfit / matplotlib). If your stack is different (R, JS, or embedding into an existing larger project), just swap the "module structure" section for the equivalent — the math and workflow stay the same.

---

## 0. What this module needs to answer

Given a set of kinetic plate reader data (RFU + OD600 over time, across multiple AHL concentrations and strains), output:

1. **Each strain's dose-response curve**: EC50, Hill coefficient n, dynamic range, fold-change (with 95% CI).
2. **Each curve's time-course kinetics**: onset time, response rate, plateau.
3. **Detection limits LOD / LOQ** (in nM).
4. **Diagnostic call**: whether this strain responds to AHL at all (the flatness test).
5. QC report (growth inhibition, DMSO effects, replicate variability).

**Design principle**: keep the pure math (Hill, logistic) separate from data handling, so the former can be unit-tested against synthetic data alone.

---

## 1. Experiment structure (the shape the code needs to know)

- **AHL concentration** (3-oxo-C12-HSL): `0, 1e-9, 1e-8, 1e-7, 1e-6, 1e-5` M (i.e. 0, 1, 10, 100 nM, 1, 10 µM); final DMSO concentration is fixed at 0.5% across the whole plate.
- **Strains**: TOP10, DH5α, BL21 (compared against each other to pick the best chassis).
- **Readings**: kinetic, OD600 + GFP (Ex/Em ≈ 485/510 nm), once per hour, for 6-8 hours or until plateau.
- **Replicates**: n ≥ 3 per condition.
- **Plate map (design v.1)**: row = concentration, column = strain.

| Row | Contents | Col 1–3 | Col 4–6 | Col 7–9 |
|-----|------|---------|---------|---------|
| A | 0 nM (DMSO only, neg ctrl) | TOP10 | DH5α | BL21 |
| B | 1 nM | TOP10 | DH5α | BL21 |
| C | 10 nM | TOP10 | DH5α | BL21 |
| D | 100 nM | TOP10 | DH5α | BL21 |
| E | 1 µM | TOP10 | DH5α | BL21 |
| F | 10 µM | TOP10 | DH5α | BL21 |
| G | Blank (media + DMSO, no cells) | TOP10-well | DH5α-well | BL21-well |
| H | Positive control (H1–3) | — | — | — |

> Don't hardcode the plate map in the code — put it in config (see §7), since the layout will change later.

---

## 2. Recommended tech stack

| Purpose | Package |
|------|------|
| Numerics/data | `numpy`, `pandas` |
| Fitting + parameter CIs | `lmfit` (preferred — `conf_interval()` gives a CI directly); fallback `scipy.optimize.curve_fit` + bootstrap |
| Statistical tests | `scipy.stats` (Welch t-test, F-test) |
| Plotting | `matplotlib` |
| Config file | `pyyaml` |
| Testing | `pytest` |

---

## 3. Module structure

```
dose_response/
├── config/
│   ├── experiment.yaml        # concentrations, plate map, Ex/Em, thresholds
│   └── plate_map.csv          # or written directly into the yaml
├── data/raw/                  # raw files exported by the reader
├── src/dose_response/
│   ├── __init__.py
│   ├── models.py              # pure math: hill(), logistic_time(), inverse functions — testable on their own
│   ├── io.py                  # load_reader_export(), load_plate_map(), to_tidy()
│   ├── normalize.py           # blank_subtract(), normalize_fluorescence()
│   ├── timeseries.py          # onset_time(), response_rate(), plateau(), fit_time_sigmoid()
│   ├── doseresponse.py        # fit_hill(), ec50_with_ci(), flatness_test(), lod_loq()
│   ├── qc.py                  # growth_check(), cv_check(), dmso_check()
│   ├── plots.py               # the three standard plots
│   └── pipeline.py            # chains everything together end-to-end
├── tests/
│   ├── test_models.py         # ★ recovers a known EC50 from synthetic data
│   ├── test_normalize.py
│   └── test_doseresponse.py
├── scripts/run_analysis.py    # CLI entry point
└── outputs/                   # generated tables and plots
```

---

## 4. Data format

### 4.1 Internal standard format (tidy long)
Every downstream function consumes this table:

| Column | Type | Description |
|------|------|------|
| `strain` | str | TOP10 / DH5α / BL21 |
| `concentration_M` | float | AHL molar concentration; 0 is kept as 0 |
| `replicate` | int | replicate number |
| `time_h` | float | reading time (hours) |
| `RFU` | float | raw fluorescence |
| `OD600` | float | raw OD |
| `well` | str | e.g. "A1" |
| `role` | str | sample / blank / positive |

### 4.2 Input source
`load_reader_export()` needs to consume a SpectraMax M2/M2e export (usually one 8x12 matrix per timepoint, OD and RFU separate). **Write it as an adapter pattern**: one parser per export format, all returning the same tidy table; supporting a different instrument later just means adding a parser.

> The team currently curates data by hand in a spreadsheet (`iGEM-wet-lab-data.xlsb`); this module should replace that step: raw export -> tidy -> analysis, directly.

---

## 5. Math core (`models.py` + each step)

### 5.1 Normalization
For every well `w` and time `t`:

```
OD_corr(w,t)  = OD600(w,t) − OD_blank(t)          # blank = row G (no cells), averaged at the same timepoint
RFU_corr(w,t) = RFU(w,t)   − RFU_blank(t)
F(w,t)        = RFU_corr(w,t) / OD_corr(w,t)       # set to NaN if OD_corr < OD_min (gating)
```

`OD_min` is suggested at 0.02 (put it in config). Each (strain, conc, t) triple then takes mean ± SD across replicates.

> **Decision (§10 item 3, made while implementing `normalize.py`)**: when `F(w,t)` comes out negative, **it is not clamped at all** — the raw negative value is passed downstream as-is. Reason: negative values only show up at early, low-signal timepoints (a noise regime where background > signal; in the synthetic dataset this is concentrated at t=0–2h, and everything turns positive by t≥3h), and they don't affect the plateau or the downstream EC50 fit. Zeroing them would systematically inflate the mean of the low-dose groups (especially the 0 nM control), contaminating the baseline estimates used by the §5.4 flatness test and the §5.5 LOD/LOQ. If a non-negative visual is wanted later when plotting (§6), the y-axis lower bound can be clamped to 0 at plot time only — the raw data in `tidy_normalized.csv` must not be altered. **This is expected behavior, not a bug**; don't treat a negative F you see later as an error to "fix".

### 5.2 Time-course kinetics metrics (per strain x concentration curve)
**Primary method: fit a time-course logistic**

```
F(t) = F0 + (Fmax − F0) / (1 + exp(−r · (t − t0)))
```

- `plateau = Fmax`
- `rate    = r · (Fmax − F0) / 4` (the logistic's maximum slope)
- `t_half  = t0`

> **Implementation finding (§10 item 4, `timeseries.py`)**: the 0 nM / low-dose curves are still climbing across the entire 8-hour observation window (because of the "early background > signal" effect noted in §5.1 — F rises from deeply negative all the way to the end of the window without ever showing a flat tail), and this shape makes the logistic's `f0`/`t0` non-identifiable. `curve_fit` doesn't raise an error, but on this synthetic dataset it actually fits `t0≈-13h` and `f0≈-2,000,000` (for an 8-hour experiment!), which blows `rate=r·(Fmax−F0)/4` up to an absurd value in the hundreds of thousands. Countermeasure: after fitting, additionally check whether `t0` falls outside the observation window by more than some margin (currently 50% of the window width is used as the tolerance); if it does, treat the fit as "not converged" and fall back to the fallback formula instead. `plateau` (Fmax) itself is actually reasonable in these cases (the tail does show a slowdown) — the problem is confined to `f0`/`t0`/`rate`.

**Onset time (fit-independent, more robust)**: using the same strain's 0 nM condition as the control, find the **first** timepoint that starts a run of **at least 2 consecutive timepoints** where F(conc) exceeds `mean_0nM + k·SD_0nM` (k is in config, default 3).

> **Implementation clarification**: `mean_0nM`/`SD_0nM` are computed **separately per timepoint** (same timepoint, across replicates), not pooled across the whole time series. Reason: the 0 nM condition's own F also drifts from deeply negative up to roughly 100-200 over the 8 hours (the same effect as above); pooling every timepoint into one SD would inflate it to ~230-250, pushing the `mean+3·SD` threshold so high that almost no dose group could ever cross it, making onset detection effectively useless. Computed per timepoint instead, the SD stays in the single-to-double digits, matching each timepoint's actual noise level.

**Fallback** (when the logistic fit fails): `plateau = mean(last 2 readings)`, `rate = max finite-difference slope`, `onset = the threshold crossing described above`.

**Flag**: if the slope between the last two points is still significantly > 0 -> `plateau_reached = False` (common at low concentrations, which haven't reached a plateau within 8 hours).

> **Implementation clarification**: no formal test was given for "significantly > 0" — mathematically, a logistic's slope is never exactly 0 in finite time, so a literal ">0" check would mark every converged curve as "not reaching plateau". This instead uses "the slope between the last two points is ≤ 10% of the curve's own maximum slope (near t0)" as the criterion — the 10% is a chosen empirical threshold, not a number given by the spec.

### 5.3 Dose-response (per strain, plateau vs [AHL])
**Hill (activation form)**:

```
F_plateau([A]) = bottom + (top − bottom) · [A]^n / (EC50^n + [A]^n)
```

Fit parameters and bounds:

| Parameter | Initial value | Bounds |
|------|------|------|
| `bottom` | the 0 nM condition's plateau | ≥ 0 |
| `top`    | the highest-concentration condition's plateau | > bottom |
| `EC50`   | the middle concentration | > 0 |
| `n`      | 1.0 | [0.5, 4] |

**Implementation notes**:
- More stable to fit in **log10[A]** coordinates.
- **[A]=0 is excluded from the fit** (can't take its log), but the 0 nM condition's plateau is used as the `bottom` initial value, and it's drawn as the leftmost reference point on the plot.
- Use `lmfit`'s `conf_interval()` to get **EC50's 95% CI**; for the `scipy` version, use residual bootstrap instead.
- Output: `EC50 (nM)`, `n`, `dynamic_range = top/bottom`, `R²`.

### 5.4 Flatness test (★ the key diagnostic — do not skip)
Since the sensor may currently not respond to AHL at all, whether dose-dependence genuinely exists must be determined:

- Fit the **Hill model** vs a **constant model** (F = the mean).
- Compare using an **F-test** or **ΔAIC**.
- If Hill isn't significantly better (p > 0.05 or ΔAIC < 2) -> report `responsive = False`, `EC50 = None`, and **never output a fake EC50**. Example message: `"No significant dose-dependence detected; EC50 not identifiable."`

### 5.5 LOD / LOQ
Using the 0 nM condition's distribution as the baseline:

```
signal_threshold_LOD = mean_0nM + 3 · SD_0nM
signal_threshold_LOQ = mean_0nM + 10 · SD_0nM
```

`LOD = the smallest [AHL] whose plateau mean ≥ the LOD threshold and whose one-sided Welch t-test against 0 nM is significant (α=0.05)`. Reported in nM; if none is found, report `> 10 µM (not detectable in tested range)`.

---

## 6. QC checks (`qc.py`)
- **Growth inhibition**: compare the OD600 growth curves across concentrations; if a high-concentration condition's endpoint OD is more than X% lower than 0 nM's (config, default 20%) -> flag `growth_inhibition`, since this would distort the RFU/OD normalization.
- **DMSO effect**: 0 nM (DMSO) vs a pure blank, to confirm the solvent itself isn't suppressing growth or adding background.
- **Replicate CV**: compute the CV for each condition; flag it above a threshold (config, default 20%).
- **OD gating record**: report how many (well, time) pairs were gated out.

---

## 7. Config (`experiment.yaml`)

```yaml
fluorescence:
  ex_nm: 485
  em_nm: 510
read_interval_h: 1.0
concentrations_M:   # maps to rows
  A: 0.0
  B: 1.0e-9
  C: 1.0e-8
  D: 1.0e-7
  E: 1.0e-6
  F: 1.0e-5
strains:            # maps to column ranges
  TOP10: [1, 2, 3]
  DH5a:  [4, 5, 6]
  BL21:  [7, 8, 9]
roles:
  blank_row: G
  positive_wells: [H1, H2, H3]
thresholds:
  od_min: 0.02
  onset_k_sd: 3
  cv_max: 0.20
  growth_inhibition_frac: 0.20
hill:
  n_bounds: [0.5, 4.0]
```

---

## 8. Output

**Tables (CSV, saved to outputs/)**
- `tidy_normalized.csv`: every (strain, conc, replicate, time, F).
- `timeseries_metrics.csv`: each strain x concentration's onset, rate, plateau ± SD, plateau_reached.
- `doseresponse_params.csv`: each strain's EC50, EC50_CI, n, top, bottom, dynamic_range, R², responsive, LOD_nM, LOQ_nM.
- `qc_report.csv`.

**Plots (PNG)**
- `growth_curves.png`: OD600 vs time, one line per concentration (to check for growth inhibition).
- `timecourse_normF.png`: normalized fluorescence vs time, one plot per strain, one line per concentration.
- `doseresponse.png`: each strain's plateau vs log[AHL], data points + Hill fit curve + a vertical EC50 line + a CI band; flat ones are labeled "not responsive".

---

## 9. Unit tests (write these first, as ground truth)

`tests/test_models.py`:
1. Using known parameters (`EC50=1e-7, n=1.5, top=8000, bottom=200`), generate synthetic plateaus at 6 concentrations with a small amount of Gaussian noise added -> `fit_hill()` should recover EC50 within ±20% and n within ±0.3.
2. Generate a **flat** synthetic curve (top≈bottom) -> `flatness_test()` should return `responsive=False`.
3. `hill()` boundaries: `[A]→0` returns `bottom`, `[A]→∞` returns `top`, `[A]=EC50` returns `(top+bottom)/2`.

> **Done (§10 item 4)**: items 1 and 2 actually live in `tests/dose_response/test_doseresponse.py`, calling `doseresponse.py`'s real `fit_hill()`/`flatness_test()` directly (not a stand-in version). The original placeholder test in `test_models.py` that fit `hill()` directly with `scipy.optimize.curve_fit` has been removed.

`tests/test_normalize.py`: given a synthetic RFU/OD/blank matrix, verify that blank subtraction and OD gating are correct.

---

## 10. Suggested build order (milestones for Claude Code)

1. `models.py` (pure functions) + `test_models.py` — get the math correct and verifiable first.
2. `io.py`: one SpectraMax parser + plate map loading + to_tidy + `test`.
3. `normalize.py` + `test`.
4. `doseresponse.py`: fit_hill -> flatness_test -> lod_loq -> EC50 CI.
5. `timeseries.py`: onset / rate / plateau.
6. `qc.py`.
7. `plots.py`: the three plots.
8. `pipeline.py` + `scripts/run_analysis.py` (CLI: takes config + a raw data folder -> produces outputs).

---

## 11. Reference implementation (pinning down the two most numerically sensitive pieces; Claude Code fills in the rest)

```python
# models.py
import numpy as np

def hill(A, bottom, top, ec50, n):
    """Activation Hill. A in molar (>0 for fitting)."""
    A = np.asarray(A, dtype=float)
    return bottom + (top - bottom) * A**n / (ec50**n + A**n)

def logistic_time(t, f0, fmax, r, t0):
    return f0 + (fmax - f0) / (1.0 + np.exp(-r * (t - t0)))
```

```python
# doseresponse.py  (lmfit version, gets the EC50 CI)
import numpy as np
from lmfit import Model
from scipy import stats

def fit_hill(conc_M, plateau, plateau_sd=None):
    """conc_M, plateau: 1D arrays aligned. Excludes conc==0 (used separately to estimate bottom)."""
    mask = conc_M > 0
    x, y = conc_M[mask], plateau[mask]
    bottom0 = float(plateau[conc_M == 0].mean()) if (conc_M == 0).any() else float(y.min())

    model = Model(hill)
    params = model.make_params(
        bottom=bottom0, top=float(y.max()),
        ec50=float(np.median(x)), n=1.0,
    )
    params['bottom'].min = 0
    params['top'].min = params['bottom'].value
    params['ec50'].min = 0
    params['n'].set(min=0.5, max=4.0)

    weights = 1.0 / plateau_sd[mask] if plateau_sd is not None else None
    result = model.fit(y, params, A=x, weights=weights)
    return result  # result.params['ec50'].value / .stderr; result.conf_interval()

def flatness_test(result, y):
    """F-test: Hill vs a constant model. Returns (responsive: bool, p: float)."""
    rss_full = np.sum(result.residual**2)
    rss_null = np.sum((y - y.mean())**2)
    n = len(y); p_full, p_null = 4, 1
    df1, df2 = p_full - p_null, n - p_full
    if df2 <= 0 or rss_full <= 0:
        return False, 1.0
    F = ((rss_null - rss_full) / df1) / (rss_full / df2)
    p = 1 - stats.f.cdf(F, df1, df2)
    return (p < 0.05), float(p)
```

---

## 12. How this model feeds into what's next
The fitted `EC50 / n / top / bottom` feed directly into two downstream models:
- **Mechanistic ODE model**: EC50 and n calibrate the pLas promoter's activation function.
- **AHL pH-hydrolysis + co-culture model**: treats EC50 as the "detection threshold", layering AHL's decay curve at pH 8.3 on top, to explain why co-culture can't detect it.

So `doseresponse_params.csv` needs to be designed as a clean interface those two models can read directly.
