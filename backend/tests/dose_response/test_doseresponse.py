import numpy as np
import pandas as pd
import pytest

from app.dose_response.models import hill
from app.dose_response.doseresponse import fit_hill, flatness_test, lod_loq, predict_concentration

CONCENTRATIONS = np.array([0.0, 1e-9, 1e-8, 1e-7, 1e-6, 1e-5])


def _synthetic_plateaus(true_bottom, true_top, true_ec50, true_n, noise_sd, seed=0):
    rng = np.random.default_rng(seed)
    plateaus = hill(CONCENTRATIONS, true_bottom, true_top, true_ec50, true_n)
    return plateaus + rng.normal(0, noise_sd, CONCENTRATIONS.shape)


# --- fit_hill(): recovers known EC50/n from noisy synthetic data (spec §9 item 1) ---
# The real replacement for test_models.py's temporary scipy.curve_fit stand-in.


def test_fit_hill_recovers_known_ec50_and_n():
    true_bottom, true_top, true_ec50, true_n = 200.0, 8000.0, 1e-7, 1.5
    plateaus = _synthetic_plateaus(true_bottom, true_top, true_ec50, true_n, noise_sd=0.02 * 7800)

    fit = fit_hill(CONCENTRATIONS, plateaus)

    assert fit.converged
    assert fit.ec50_M == pytest.approx(true_ec50, rel=0.20)
    assert fit.n == pytest.approx(true_n, abs=0.3)


def test_fit_hill_excludes_zero_concentration_from_the_fit_but_uses_it_for_bottom_init():
    """conc=0 can't be log10'd - fit_hill() must mask it out of the regression
    itself (only the 5 positive concentrations go into the Hill fit), while
    still using its plateau as bottom's initial guess (spec §5.3).

    Checked directly via the fitted data count, not by poisoning the conc=0
    plateau and checking recovery still happens: that value doubles as
    bottom's initial guess by design, so an extreme poison value corrupts
    the optimizer's starting point (a confound) rather than isolating
    whether conc=0 leaked into the regression itself.
    """
    true_bottom, true_top, true_ec50, true_n = 200.0, 8000.0, 1e-7, 1.5
    plateaus = _synthetic_plateaus(true_bottom, true_top, true_ec50, true_n, noise_sd=0.02 * 7800)

    fit = fit_hill(CONCENTRATIONS, plateaus)

    assert fit.converged
    assert len(fit.lmfit_result.residual) == 5  # 6 concentrations minus the excluded conc=0


def test_fit_hill_ec50_ci95_brackets_the_point_estimate():
    plateaus = _synthetic_plateaus(200.0, 8000.0, 1e-7, 1.5, noise_sd=0.02 * 7800)
    fit = fit_hill(CONCENTRATIONS, plateaus)

    assert fit.ec50_M_ci95 is not None
    lo, hi = fit.ec50_M_ci95
    assert lo < fit.ec50_M < hi


def test_fit_hill_accepts_optional_replicate_weights_without_error():
    plateaus = _synthetic_plateaus(200.0, 8000.0, 1e-7, 1.5, noise_sd=0.02 * 7800)
    sd = np.full(CONCENTRATIONS.shape, 50.0)

    fit = fit_hill(CONCENTRATIONS, plateaus, plateau_sd=sd)

    assert fit.converged
    assert fit.ec50_M == pytest.approx(1e-7, rel=0.2)


def test_fit_hill_does_not_converge_with_too_few_positive_concentrations():
    fit = fit_hill(np.array([0.0, 1e-8, 1e-7]), np.array([200.0, 1000.0, 5000.0]))
    assert not fit.converged
    assert fit.lmfit_result is None


# --- flatness_test(): Hill vs constant model (spec §5.4) ---


def test_flatness_test_detects_a_real_dose_response_as_responsive():
    plateaus = _synthetic_plateaus(200.0, 8000.0, 1e-7, 1.5, noise_sd=0.02 * 7800)
    mask = CONCENTRATIONS > 0
    fit = fit_hill(CONCENTRATIONS, plateaus)

    result = flatness_test(fit, plateaus[mask])

    assert result.responsive
    assert result.p_value < 0.05


def test_flatness_test_flags_a_flat_curve_as_not_responsive():
    """spec §9 item 2: top~=bottom synthetic curve -> responsive=False.
    Previously flagged as not-yet-covered in test_models.py; now that
    doseresponse.py exists, this is that test.
    """
    rng = np.random.default_rng(1)
    plateaus = 500.0 + rng.normal(0, 5.0, CONCENTRATIONS.shape)  # pure noise, no dose-dependence
    mask = CONCENTRATIONS > 0
    fit = fit_hill(CONCENTRATIONS, plateaus)

    result = flatness_test(fit, plateaus[mask])

    assert not result.responsive
    assert result.p_value > 0.05


# --- lod_loq(): detection/quantification limits (spec §5.5) ---


def _normalized_for_lod(zero_vals, conc_to_vals):
    """Builds a minimal normalized-shaped frame: one strain, one replicate
    group per concentration, 2 time points per replicate (plateau() needs
    >=2 points; both are set equal so plateau just returns that value).
    """
    rows = []
    for replicate, val in enumerate(zero_vals, start=1):
        for t in (0.0, 1.0):
            rows.append(
                {
                    "strain": "TOP10",
                    "concentration_M": 0.0,
                    "replicate": replicate,
                    "time_h": t,
                    "F": val,
                    "role": "sample",
                }
            )
    for conc, vals in conc_to_vals.items():
        for replicate, val in enumerate(vals, start=1):
            for t in (0.0, 1.0):
                rows.append(
                    {
                        "strain": "TOP10",
                        "concentration_M": conc,
                        "replicate": replicate,
                        "time_h": t,
                        "F": val,
                        "role": "sample",
                    }
                )
    return pd.DataFrame(rows)


def test_lod_loq_finds_lowest_concentration_clearing_threshold_and_significance():
    # 0 nM: mean=100, sd=2 -> LOD threshold=106, LOQ threshold=120
    zero_vals = [98.0, 100.0, 102.0]
    normalized = _normalized_for_lod(
        zero_vals,
        {
            1e-9: [101.0, 103.0, 99.0],  # mean~101: below LOD threshold (106) -> skip
            1e-8: [200.0, 205.0, 195.0],  # mean=200: clears both thresholds, far from 0nM -> qualifies
            1e-7: [400.0, 410.0, 390.0],
        },
    )

    result = lod_loq(normalized, "TOP10")

    assert result.mean_0nM == pytest.approx(100.0)
    assert result.lod_nM == pytest.approx(1e-8 * 1e9)
    assert result.loq_nM == pytest.approx(1e-8 * 1e9)


def test_lod_loq_returns_none_when_nothing_clears_the_bar():
    zero_vals = [98.0, 100.0, 102.0]
    normalized = _normalized_for_lod(zero_vals, {1e-9: [99.0, 101.0, 100.0], 1e-8: [101.0, 103.0, 99.0]})

    result = lod_loq(normalized, "TOP10")

    assert result.lod_nM is None
    assert result.loq_nM is None


# --- predict_concentration(): inverts hill(), round-trips a known concentration ---

BOTTOM, TOP, EC50, N = 200.0, 8000.0, 1e-7, 1.5


@pytest.mark.parametrize("true_conc", [1e-9, 3e-8, 1e-7, 4e-7, 5e-6])
def test_predict_concentration_recovers_known_concentration(true_conc):
    """spec §9 style: compute F from a known concentration via hill(), then
    invert it back and check the original concentration is recovered.
    """
    F = hill(true_conc, BOTTOM, TOP, EC50, N)

    result = predict_concentration(F, BOTTOM, TOP, EC50, N)

    assert result.in_range
    assert result.concentration_M == pytest.approx(true_conc, rel=1e-6)


def test_predict_concentration_at_or_below_bottom_is_out_of_range():
    result = predict_concentration(BOTTOM, BOTTOM, TOP, EC50, N)
    assert not result.in_range
    assert result.concentration_M is None
    assert result.message is not None

    result_below = predict_concentration(BOTTOM - 50.0, BOTTOM, TOP, EC50, N)
    assert not result_below.in_range
    assert result_below.concentration_M is None


def test_predict_concentration_at_or_above_top_is_out_of_range():
    result = predict_concentration(TOP, BOTTOM, TOP, EC50, N)
    assert not result.in_range
    assert result.concentration_M is None
    assert result.message is not None

    result_above = predict_concentration(TOP + 50.0, BOTTOM, TOP, EC50, N)
    assert not result_above.in_range
    assert result_above.concentration_M is None


def test_predict_concentration_never_returns_nan_or_raises_out_of_range():
    """The spec explicitly says out-of-range must not surface as NaN or an
    exception - check both boundary directions produce a clean structured
    result, not a NaN slipping through.
    """
    for F in (BOTTOM, BOTTOM - 1.0, TOP, TOP + 1.0):
        result = predict_concentration(F, BOTTOM, TOP, EC50, N)
        assert result.concentration_M is None  # not float("nan")
        assert not result.in_range


def test_predict_concentration_propagates_ec50_ci_linearly():
    true_conc = EC50 * 2  # arbitrary point away from EC50 itself
    F = hill(true_conc, BOTTOM, TOP, EC50, N)
    ci95 = (EC50 * 0.8, EC50 * 1.2)  # a made-up +/-20% EC50 CI

    result = predict_concentration(F, BOTTOM, TOP, EC50, N, ec50_M_ci95=ci95)

    assert result.concentration_M_ci95 is not None
    lo, hi = result.concentration_M_ci95
    assert lo == pytest.approx(true_conc * 0.8, rel=1e-6)
    assert hi == pytest.approx(true_conc * 1.2, rel=1e-6)
    assert lo < result.concentration_M < hi


def test_predict_concentration_ci_is_none_when_not_given():
    F = hill(EC50, BOTTOM, TOP, EC50, N)
    result = predict_concentration(F, BOTTOM, TOP, EC50, N)
    assert result.concentration_M_ci95 is None
