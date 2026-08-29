"""Dose-response fitting, flatness test, and detection limits (spec §5.3-5.5).

fit_hill()/flatness_test() take plain (concentration, plateau) arrays -
typically timeseries.plateau() run once per (strain, concentration) on the
replicate-mean curve. lod_loq() takes the normalized DataFrame directly
because §5.5 needs a real per-replicate plateau *distribution* (mean, SD,
and enough n for a t-test) at each concentration, not one aggregated value.
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd
from lmfit import Model
from scipy import stats

from app.dose_response.config import load_config
from app.dose_response.models import hill
from app.dose_response.timeseries import plateau

MIN_POSITIVE_CONCENTRATIONS = 4  # >= free Hill params (bottom, top, log10_ec50, n)
_N_BOUNDS = load_config().hill.n_bounds


@dataclass
class FitHillResult:
    bottom: float
    top: float
    ec50_M: float
    n: float
    ec50_M_ci95: tuple[float, float] | None
    r_squared: float
    converged: bool
    lmfit_result: object | None  # lmfit.model.ModelResult, consumed by flatness_test()


@dataclass
class ConcentrationPrediction:
    concentration_M: float | None  # None when out of range
    concentration_M_ci95: tuple[float, float] | None
    in_range: bool
    message: str | None  # explains why, when in_range is False


@dataclass
class FlatnessResult:
    responsive: bool
    p_value: float


@dataclass
class LodLoqResult:
    lod_nM: float | None
    loq_nM: float | None
    mean_0nM: float
    sd_0nM: float


def _hill_log10x(log10_A: np.ndarray, bottom: float, top: float, log10_ec50: float, n: float) -> np.ndarray:
    """Hill equation reparametrized for fitting in log10[A] space (spec §5.3:
    "在 log10[A] 座標上擬合較穩定"). Delegates to models.hill() so the Hill
    formula itself has one implementation; this only converts the log10
    x-axis and log10(EC50) parameter back to linear before calling it -
    EC50 can span many orders of magnitude (1e-9 to 1e-5 M here), which is
    poorly conditioned for a direct linear-space search.
    """
    A = 10.0 ** np.asarray(log10_A, dtype=float)
    ec50 = 10.0**log10_ec50
    return hill(A, bottom, top, ec50, n)


def fit_hill(
    conc_M: np.ndarray,
    plateau: np.ndarray,
    plateau_sd: np.ndarray | None = None,
) -> FitHillResult:
    """Fit the Hill dose-response equation to plateau vs [AHL] (spec §5.3).

    conc_M==0 is excluded from the fit itself (can't take log10(0)) but its
    plateau is used as bottom's initial guess, per spec §5.3.
    """
    conc_M = np.asarray(conc_M, dtype=float)
    plateau_arr = np.asarray(plateau, dtype=float)

    mask = conc_M > 0
    x_log = np.log10(conc_M[mask])
    y = plateau_arr[mask]

    if x_log.size < MIN_POSITIVE_CONCENTRATIONS:
        return FitHillResult(
            bottom=float("nan"),
            top=float("nan"),
            ec50_M=float("nan"),
            n=float("nan"),
            ec50_M_ci95=None,
            r_squared=float("nan"),
            converged=False,
            lmfit_result=None,
        )

    bottom0 = float(plateau_arr[conc_M == 0].mean()) if (conc_M == 0).any() else float(y.min())

    model = Model(_hill_log10x)
    params = model.make_params(bottom=bottom0, top=float(y.max()), log10_ec50=float(np.median(x_log)), n=1.0)
    params["bottom"].min = 0
    params["top"].min = params["bottom"].value
    params["n"].set(min=_N_BOUNDS[0], max=_N_BOUNDS[1])

    weights = 1.0 / plateau_sd[mask] if plateau_sd is not None else None
    result = model.fit(y, params, log10_A=x_log, weights=weights)

    ec50_M = 10.0 ** result.params["log10_ec50"].value
    rss_full = float(np.sum(result.residual**2))
    rss_null = float(np.sum((y - y.mean()) ** 2))
    r_squared = 1.0 - rss_full / rss_null if rss_null > 0 else float("nan")

    ci95 = None
    try:
        ci = result.conf_interval(sigmas=[0.95], p_names=["log10_ec50"])
        lo, hi = ci["log10_ec50"][0][1], ci["log10_ec50"][-1][1]
        ci95 = (10.0**lo, 10.0**hi)
    except Exception:
        ci95 = None

    return FitHillResult(
        bottom=result.params["bottom"].value,
        top=result.params["top"].value,
        ec50_M=ec50_M,
        n=result.params["n"].value,
        ec50_M_ci95=ci95,
        r_squared=r_squared,
        converged=bool(result.success),
        lmfit_result=result,
    )


def predict_concentration(
    F: float,
    bottom: float,
    top: float,
    ec50_M: float,
    n: float,
    ec50_M_ci95: tuple[float, float] | None = None,
) -> ConcentrationPrediction:
    """Invert the Hill equation to back-calculate [A] from a measured F.

    Algebraic inverse of spec §5.3's F = bottom + (top-bottom)*A^n/(EC50^n+A^n):
    [A] = EC50 * ((F-bottom)/(top-F))^(1/n).

    The model's achievable range for A in (0, inf) is the OPEN interval
    (bottom, top) - F<=bottom or F>=top means no positive concentration
    could have produced this reading (not a fit failure), so this reports
    in_range=False with a message instead of returning NaN or raising.

    ec50_M_ci95, when given (e.g. fit.ec50_M_ci95 from fit_hill()), is
    propagated through the same formula to get concentration_M_ci95. This
    is EC50's uncertainty only, not bottom/top/n's - but for fixed
    F/bottom/top/n the inverse is exactly linear in EC50 (the rest of the
    formula is just a positive scale factor), so that one-parameter
    propagation is exact, not an approximation, for what it covers. Full
    multi-parameter propagation isn't implemented.
    """
    if F <= bottom:
        return ConcentrationPrediction(
            None, None, False, f"F={F:g} is at or below the bottom asymptote ({bottom:g}): out of range"
        )
    if F >= top:
        return ConcentrationPrediction(
            None, None, False, f"F={F:g} is at or above the top asymptote ({top:g}): out of range"
        )

    scale = ((F - bottom) / (top - F)) ** (1.0 / n)
    concentration_M = ec50_M * scale

    ci95 = None
    if ec50_M_ci95 is not None:
        lo_ec50, hi_ec50 = ec50_M_ci95
        ci95 = (lo_ec50 * scale, hi_ec50 * scale)

    return ConcentrationPrediction(concentration_M, ci95, True, None)


def flatness_test(fit_result: FitHillResult, plateau_fitted: np.ndarray) -> FlatnessResult:
    """Hill model vs. constant model (F-test), spec §5.4.

    plateau_fitted MUST be the same y (positive-concentration plateaus only)
    that produced fit_result, for a fair nested-model comparison - not the
    full array including the excluded [A]=0 point.
    """
    if fit_result.lmfit_result is None:
        return FlatnessResult(responsive=False, p_value=1.0)

    y = np.asarray(plateau_fitted, dtype=float)
    rss_full = float(np.sum(fit_result.lmfit_result.residual**2))
    rss_null = float(np.sum((y - y.mean()) ** 2))

    n = len(y)
    p_full, p_null = 4, 1
    df1, df2 = p_full - p_null, n - p_full
    if df2 <= 0 or rss_full <= 0:
        return FlatnessResult(responsive=False, p_value=1.0)

    F = ((rss_null - rss_full) / df1) / (rss_full / df2)
    p = 1.0 - stats.f.cdf(F, df1, df2)
    return FlatnessResult(responsive=bool(p < 0.05), p_value=float(p))


def _plateaus_by_replicate(normalized: pd.DataFrame, strain: str, concentration_M: float) -> np.ndarray:
    """Per-replicate plateau values for one strain x concentration.

    §5.5's LOD/LOQ needs a real distribution across replicates (mean, SD,
    and enough n for a t-test) - unlike fit_hill(), which only needs one
    plateau per concentration from the replicate-mean curve.
    """
    subset = normalized[(normalized["strain"] == strain) & (normalized["concentration_M"] == concentration_M)]
    values = []
    for _, rep_df in subset.groupby("replicate"):
        rep_df = rep_df.dropna(subset=["F"]).sort_values("time_h")
        if len(rep_df) < 2:
            continue
        value, _ = plateau(rep_df["time_h"].to_numpy(), rep_df["F"].to_numpy())
        values.append(value)
    return np.array(values, dtype=float)


def _lowest_significant_concentration(
    normalized: pd.DataFrame,
    strain: str,
    positive_concs_M: list[float],
    zero_plateaus: np.ndarray,
    threshold: float,
) -> float | None:
    for conc in positive_concs_M:
        plateaus = _plateaus_by_replicate(normalized, strain, conc)
        if plateaus.size == 0 or np.mean(plateaus) < threshold:
            continue
        _, p = stats.ttest_ind(plateaus, zero_plateaus, equal_var=False, alternative="greater")
        if p < 0.05:
            return float(conc) * 1e9
    return None


def lod_loq(normalized: pd.DataFrame, strain: str) -> LodLoqResult:
    """Detection/quantification limits from the 0 nM plateau distribution (spec §5.5).

    Searches ascending through the strain's tested positive concentrations
    for the lowest one that both clears mean_0nM + k*SD_0nM and is
    significantly above 0 nM by a one-tailed Welch t-test (alpha=0.05).
    Returns None (not the "> 10 uM" fallback string) when nothing qualifies
    - spec's own suggested display text for that case, left to the caller.
    """
    zero = _plateaus_by_replicate(normalized, strain, 0.0)
    mean_0, sd_0 = float(np.mean(zero)), float(np.std(zero, ddof=1))

    lod_threshold = mean_0 + 3 * sd_0
    loq_threshold = mean_0 + 10 * sd_0

    positive_concs = sorted(
        normalized.loc[
            (normalized["strain"] == strain) & (normalized["role"] == "sample") & (normalized["concentration_M"] > 0),
            "concentration_M",
        ].unique()
    )

    lod_nM = _lowest_significant_concentration(normalized, strain, positive_concs, zero, lod_threshold)
    loq_nM = _lowest_significant_concentration(normalized, strain, positive_concs, zero, loq_threshold)

    return LodLoqResult(lod_nM=lod_nM, loq_nM=loq_nM, mean_0nM=mean_0, sd_0nM=sd_0)
