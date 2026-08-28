import numpy as np
import pandas as pd
import pytest

from app.dose_response.models import logistic_time
from app.dose_response.timeseries import (
    aggregate_by_condition,
    fit_time_sigmoid,
    onset_time,
    plateau,
    response_rate,
)

T = np.arange(0.0, 8.0, 1.0)  # 0..7h, matches the real experiment's read schedule


# --- aggregate_by_condition() ---


def test_aggregate_computes_mean_sd_n_and_excludes_nan_and_other_conditions():
    normalized = pd.DataFrame(
        [
            {"strain": "TOP10", "concentration_M": 0.0, "time_h": 0.0, "F": 10.0},
            {"strain": "TOP10", "concentration_M": 0.0, "time_h": 0.0, "F": 12.0},
            {"strain": "TOP10", "concentration_M": 0.0, "time_h": 0.0, "F": np.nan},  # OD-gated
            {"strain": "TOP10", "concentration_M": 0.0, "time_h": 1.0, "F": 20.0},
            {"strain": "TOP10", "concentration_M": 0.0, "time_h": 1.0, "F": 24.0},
            {"strain": "TOP10", "concentration_M": 1e-7, "time_h": 0.0, "F": 999.0},  # different condition
            {"strain": "DH5α", "concentration_M": 0.0, "time_h": 0.0, "F": 999.0},  # different strain
        ]
    )
    agg = aggregate_by_condition(normalized, "TOP10", 0.0)

    assert len(agg) == 2
    row0 = agg[agg.time_h == 0.0].iloc[0]
    assert row0["F_mean"] == pytest.approx(11.0)
    assert row0["n"] == 2  # NaN excluded from both mean and count
    row1 = agg[agg.time_h == 1.0].iloc[0]
    assert row1["F_mean"] == pytest.approx(22.0)


# --- fit_time_sigmoid(): recovers known params from noisy synthetic data ---


def test_fit_recovers_known_params():
    rng = np.random.default_rng(0)
    true_f0, true_fmax, true_r, true_t0 = 100.0, 5000.0, 1.2, 3.5
    F = logistic_time(T, true_f0, true_fmax, true_r, true_t0)
    F = F + rng.normal(0, 0.01 * true_fmax, T.shape)

    fit = fit_time_sigmoid(T, F)

    assert fit.converged
    assert fit.fmax == pytest.approx(true_fmax, rel=0.1)
    assert fit.t0 == pytest.approx(true_t0, abs=0.5)


def test_fit_does_not_converge_with_too_few_points():
    fit = fit_time_sigmoid([0.0, 1.0, 2.0], [10.0, 20.0, 30.0])
    assert not fit.converged


def test_fit_rejects_t0_far_outside_the_observed_window_as_not_converged():
    """Reproduces the real bug found on the fixture's 0/1/10 nM curves: when a
    condition's F(t) is still rising throughout the whole observed window
    (no flat lower plateau visible - here because t0 is deliberately way
    before t=0), f0/t0 are not identifiable and curve_fit can "succeed"
    numerically at an absurd point (t0 ~ -13h, f0 ~ -2,000,000 was the
    actual fitted result for an 8h experiment). fit_time_sigmoid() must
    catch this via the t0-plausibility check, not just trust "no exception".
    """
    F = logistic_time(T, f0=-2_000_000.0, fmax=180.0, r=0.6, t0=-13.0)

    fit = fit_time_sigmoid(T, F)

    assert not fit.converged  # curve_fit itself won't raise here - this is the check that must catch it
    rate = response_rate(T, F)
    assert abs(rate) < 10_000  # fallback (max finite-difference slope), not r*(fmax-f0)/4 blowing up


def test_fit_ignores_nan_points():
    true_f0, true_fmax, true_r, true_t0 = 100.0, 5000.0, 1.2, 3.5
    F = logistic_time(T, true_f0, true_fmax, true_r, true_t0)
    F_with_gap = F.copy()
    F_with_gap[2] = np.nan  # e.g. an OD-gated timepoint

    fit = fit_time_sigmoid(T, F_with_gap)
    assert fit.converged
    assert fit.fmax == pytest.approx(true_fmax, rel=1e-3)


# --- plateau(): converged (fmax) vs fallback (mean of last 2), plateau_reached flag ---


def test_plateau_uses_fitted_fmax_and_flags_reached_when_curve_has_flattened():
    true_fmax, true_t0 = 5000.0, 3.0
    F = logistic_time(T, 100.0, true_fmax, 1.2, true_t0)

    value, reached = plateau(T, F)

    assert value == pytest.approx(true_fmax, rel=0.02)
    assert reached is True  # t0=3 on a 0-7h window: last-two-point slope has decayed well under 10% of peak


def test_plateau_flags_not_reached_when_still_rising_at_the_end():
    true_fmax, true_t0 = 5000.0, 6.0
    F = logistic_time(T, 100.0, true_fmax, 1.2, true_t0)

    _, reached = plateau(T, F)

    assert reached is False  # t0=6 is right at the end of the window - still climbing at t=6->7


def test_plateau_fallback_uses_mean_of_last_two_readings():
    t = [0.0, 1.0, 2.0]  # too few points for fit_time_sigmoid (needs >=4)
    F = [10.0, 20.0, 30.0]

    value, _ = plateau(t, F)
    assert value == pytest.approx(25.0)  # mean(20, 30)


# --- response_rate(): converged (r*(fmax-f0)/4) vs fallback (max finite diff) ---


def test_response_rate_matches_logistic_max_slope_formula():
    true_f0, true_fmax, true_r, true_t0 = 100.0, 5000.0, 1.2, 3.5
    F = logistic_time(T, true_f0, true_fmax, true_r, true_t0)

    rate = response_rate(T, F)
    assert rate == pytest.approx(true_r * (true_fmax - true_f0) / 4, rel=0.05)


def test_response_rate_fallback_is_max_finite_difference_slope():
    t = [0.0, 1.0, 2.0]
    F = [10.0, 15.0, 40.0]  # slopes: 5, 25 -> max is 25

    rate = response_rate(t, F)
    assert rate == pytest.approx(25.0)


# --- onset_time(): threshold crossing against a per-time_h 0 nM baseline ---


def _baseline_df(time_h, f_mean, f_sd):
    return pd.DataFrame({"time_h": time_h, "F_mean": f_mean, "F_sd": f_sd})


def test_onset_time_finds_first_of_two_consecutive_crossings():
    baseline = _baseline_df(T, f_mean=[0.0] * 8, f_sd=[1.0] * 8)  # threshold = 3 at every t (k=3 default)
    # Below threshold at t=0,1; at/above from t=2 onward (>=2 consecutive from t=2).
    F = [0.0, 0.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0]

    assert onset_time(T, F, baseline) == pytest.approx(2.0)


def test_onset_time_skips_an_isolated_single_point_crossing():
    baseline = _baseline_df(T, f_mean=[0.0] * 8, f_sd=[1.0] * 8)
    # t=2 crosses alone (t=3 drops back below) - shouldn't count. Real run starts at t=4.
    F = [0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 0.0]

    assert onset_time(T, F, baseline) == pytest.approx(4.0)


def test_onset_time_returns_none_when_never_sustained_above_threshold():
    baseline = _baseline_df(T, f_mean=[0.0] * 8, f_sd=[1.0] * 8)
    F = [0.0] * 8  # never crosses

    assert onset_time(T, F, baseline) is None


def test_onset_time_uses_per_timepoint_baseline_not_a_pooled_one():
    """The 0 nM baseline itself drifts a lot over time (see conversation): a
    dose curve that merely tracks slightly above a RISING baseline at every
    hour should never trigger onset, even though its raw values span a huge
    range - because the comparison is local (same time_h), not pooled.
    """
    f_mean = [0.0, 100.0, 1000.0, 4000.0, 4500.0, 4800.0, 4900.0, 4950.0]
    f_sd = [1.0] * 8
    baseline = _baseline_df(T, f_mean=f_mean, f_sd=f_sd)
    F = [f + 1.0 for f in f_mean]  # always just +1 above that hour's own mean, never +3*SD

    assert onset_time(T, F, baseline) is None
