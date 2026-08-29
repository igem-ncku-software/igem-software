"""Time-course kinetics per strain x concentration curve (spec §5.2).

Input is normalize.py's per-well output (needs strain, concentration_M,
time_h, F columns). aggregate_by_condition() collapses replicates into one
(time_h, F_mean, F_sd, n) curve per condition; the other functions extract
onset/rate/plateau from that curve.
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit

from app.dose_response.config import load_config
from app.dose_response.models import logistic_time

MIN_POINTS_TO_FIT = 4
ONSET_K_SD_DEFAULT = load_config().thresholds.onset_k_sd
T0_MARGIN_FRACTION = 0.5


@dataclass
class TimeSigmoidFit:
    f0: float
    fmax: float
    r: float
    t0: float
    converged: bool


def aggregate_by_condition(normalized: pd.DataFrame, strain: str, concentration_M: float) -> pd.DataFrame:
    """Per-time_h mean/SD/n of F across replicates for one strain x concentration
    (spec §5.1's closing note: "之後每個 (strain, conc, t) 對 replicate 取 mean
    ± SD"). OD-gated NaN F rows are excluded by pandas' default skipna
    mean/std/count, not filtered explicitly here.
    """
    subset = normalized[(normalized["strain"] == strain) & (normalized["concentration_M"] == concentration_M)]
    return (
        subset.groupby("time_h")["F"]
        .agg(F_mean="mean", F_sd="std", n="count")
        .reset_index()
        .sort_values("time_h", ignore_index=True)
    )


def _clean_sorted(t: np.ndarray, F: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    t = np.asarray(t, dtype=float)
    F = np.asarray(F, dtype=float)
    mask = ~(np.isnan(t) | np.isnan(F))
    t, F = t[mask], F[mask]
    order = np.argsort(t)
    return t[order], F[order]


def fit_time_sigmoid(t: np.ndarray, F: np.ndarray) -> TimeSigmoidFit:
    """Fit F(t) = f0 + (fmax-f0)/(1+exp(-r*(t-t0))) (models.logistic_time, spec §5.2).

    converged=False both when curve_fit raises (too few/degenerate points)
    and when it "succeeds" but t0 lands far outside the observed time
    window. The latter happens for real: when a condition's F(t) never
    shows a flat LOWER plateau within the observed window (e.g. 0/low-dose
    curves here, which are still rising at t=0 because of the early
    background>signal artifact discussed in conversation - not a fit bug),
    f0 and t0 become non-identifiable and curve_fit can converge to a
    numerically-valid but physically-meaningless point (observed: t0 around
    -13h, f0 around -2,000,000, for an 8h experiment). A fit that only
    "explains" the data by placing its half-max multiple experiment-widths
    in the past isn't describing anything we actually observed, so it's
    treated the same as non-convergence and callers fall back to the
    robust finite-difference formulas instead.
    """
    t_c, F_c = _clean_sorted(t, F)
    if t_c.size < MIN_POINTS_TO_FIT:
        return TimeSigmoidFit(float("nan"), float("nan"), float("nan"), float("nan"), converged=False)

    p0 = [float(F_c[0]), float(F_c[-1]), 1.0, float(np.median(t_c))]
    try:
        popt, _ = curve_fit(logistic_time, t_c, F_c, p0=p0, maxfev=10_000)
    except RuntimeError:
        return TimeSigmoidFit(float("nan"), float("nan"), float("nan"), float("nan"), converged=False)

    f0, fmax, r, t0 = popt

    margin = T0_MARGIN_FRACTION * (t_c[-1] - t_c[0])
    plausible = (t_c[0] - margin) <= t0 <= (t_c[-1] + margin)
    return TimeSigmoidFit(f0=f0, fmax=fmax, r=r, t0=t0, converged=bool(plausible))


PLATEAU_REACHED_SLOPE_FRACTION = 0.1


def plateau(t: np.ndarray, F: np.ndarray) -> tuple[float, bool]:
    """plateau = Fmax from the sigmoid fit; fallback = mean of last 2 readings
    (spec §5.2).

    plateau_reached=False if the last two points are still rising
    "significantly" (spec's word, no formal test given). A raw slope > 0
    isn't usable here: a logistic mathematically never hits exactly zero
    slope in finite time, so that test would flag every converged fit as
    "not reached", always. Instead this compares the last-two-point slope
    to the curve's own peak finite-difference slope (near t0) and calls it
    reached once the ending slope has decayed to <=10% of that peak - a
    chosen heuristic, not a spec-given number.
    """
    t_c, F_c = _clean_sorted(t, F)
    if t_c.size < 2:
        return float("nan"), False

    fit = fit_time_sigmoid(t, F)
    value = fit.fmax if fit.converged else float(np.mean(F_c[-2:]))

    diffs = np.diff(F_c) / np.diff(t_c)
    last_slope, peak_slope = diffs[-1], np.max(diffs)
    still_rising = peak_slope > 0 and last_slope > PLATEAU_REACHED_SLOPE_FRACTION * peak_slope
    return value, not still_rising


def response_rate(t: np.ndarray, F: np.ndarray) -> float:
    """rate = r*(Fmax-F0)/4 (logistic max slope) from the sigmoid fit;
    fallback = max finite-difference slope across the trajectory (spec §5.2).
    """
    t_c, F_c = _clean_sorted(t, F)
    if t_c.size < 2:
        return float("nan")

    fit = fit_time_sigmoid(t, F)
    if fit.converged:
        return fit.r * (fit.fmax - fit.f0) / 4
    return float(np.max(np.diff(F_c) / np.diff(t_c)))


def onset_time(
    t: np.ndarray,
    F: np.ndarray,
    baseline: pd.DataFrame,
    k: float = ONSET_K_SD_DEFAULT,
) -> float | None:
    """First of >=2 consecutive time points where F exceeds mean_0nM + k*SD_0nM,
    both evaluated at the SAME time_h (spec §5.2) - a threshold crossing, not
    a fit.

    baseline: the 0 nM condition's per-time_h curve for the SAME strain,
    i.e. aggregate_by_condition(normalized, strain, 0.0) - needs time_h,
    F_mean, F_sd columns. Matched to t by time_h (inner join), not by
    position, in case the two curves' time points ever diverge.

    mean_0nM/SD_0nM MUST be taken per-time_h, not pooled across the whole
    time course: even the 0 nM condition's F drifts by hundreds of units
    over 8h here (GFP maturation / growth-coupled background), so a single
    pooled SD is inflated enough (~230-250 in the simulated fixture) that
    mean+k*SD is never crossed - see the walkthrough in conversation. Pooling
    per time_h instead keeps SD in the single digits and the comparison
    apples-to-apples ("this dose vs. 0 nM at the same hour").

    k defaults to config/experiment.yaml's thresholds.onset_k_sd (§7).
    """
    curve = pd.DataFrame({"time_h": np.asarray(t, dtype=float), "F": np.asarray(F, dtype=float)})
    curve = curve.merge(baseline[["time_h", "F_mean", "F_sd"]], on="time_h", how="inner")
    curve = curve.sort_values("time_h", ignore_index=True)

    threshold = curve["F_mean"] + k * curve["F_sd"]
    above = (curve["F"] > threshold).to_numpy()

    for i in range(len(curve) - 1):
        if above[i] and above[i + 1]:
            return float(curve.loc[i, "time_h"])
    return None
