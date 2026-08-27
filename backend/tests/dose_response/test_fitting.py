import numpy as np
import pytest

from app.dose_response.fitting import fit_dose_response
from app.dose_response.simulate import DEFAULT_CONCENTRATIONS_NM, simulate_dose_response


TRUE_PARAMS = dict(top=100.0, bottom=5.0, ec50=50.0, hill_slope=1.5)


def test_recovers_known_parameters_from_low_noise_data():
    x, y = simulate_dose_response(
        DEFAULT_CONCENTRATIONS_NM,
        **TRUE_PARAMS,
        noise_sd=0.5,
        n_replicates=4,
        seed=0,
    )

    result = fit_dose_response(x, y)

    assert result.converged
    assert result.params["ec50"] == pytest.approx(TRUE_PARAMS["ec50"], rel=0.1)
    assert result.params["hill_slope"] == pytest.approx(TRUE_PARAMS["hill_slope"], rel=0.2)
    assert result.params["top"] == pytest.approx(TRUE_PARAMS["top"], rel=0.1)
    assert result.params["bottom"] == pytest.approx(TRUE_PARAMS["bottom"], abs=3.0)
    assert result.r_squared > 0.9
    assert result.warnings == []


def test_fix_bottom_holds_bottom_constant_and_fits_remaining_three():
    x, y = simulate_dose_response(
        DEFAULT_CONCENTRATIONS_NM,
        **TRUE_PARAMS,
        noise_sd=0.5,
        n_replicates=4,
        seed=1,
    )

    result = fit_dose_response(x, y, fix_bottom=TRUE_PARAMS["bottom"])

    assert result.converged
    assert result.params["bottom"] == TRUE_PARAMS["bottom"]
    assert result.param_stderr["bottom"] == 0.0
    assert result.param_ci95["bottom"] == (TRUE_PARAMS["bottom"], TRUE_PARAMS["bottom"])
    assert result.params["ec50"] == pytest.approx(TRUE_PARAMS["ec50"], rel=0.1)


def test_predict_matches_four_pl_at_ec50():
    x, y = simulate_dose_response(
        DEFAULT_CONCENTRATIONS_NM,
        **TRUE_PARAMS,
        noise_sd=0.5,
        n_replicates=4,
        seed=2,
    )

    result = fit_dose_response(x, y)
    midpoint = (result.params["top"] + result.params["bottom"]) / 2

    assert result.predict(result.params["ec50"]) == pytest.approx(midpoint)


def test_too_few_distinct_concentrations_warns_but_does_not_crash():
    x = np.array([0.0, 0.0, 100.0, 100.0])
    y = np.array([5.0, 6.0, 90.0, 95.0])

    result = fit_dose_response(x, y)

    assert any("distinct concentration" in w for w in result.warnings)


def test_non_monotonic_signal_warns_but_does_not_crash():
    x = np.array([0.0, 1.0, 10.0, 100.0, 1000.0, 10000.0])
    y = np.array([50.0, 10.0, 8.0, 6.0, 5.0, 4.0])  # decreasing: signal quenching

    result = fit_dose_response(x, y)

    assert any("increasing trend" in w for w in result.warnings)


def test_noisy_but_genuinely_increasing_data_does_not_false_positive_on_trend():
    # Small dip between two adjacent low-dose replicate groups purely from
    # noise should NOT trigger the signal-quenching warning, since the
    # overall trend across the full gradient is clearly increasing.
    x = np.array(
        [0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 10.0, 100.0, 1000.0, 10000.0]
    )
    y = np.array([5.9, 1.9, 7.3, 8.1, -0.6, 1.4, 13.0, 75.0, 100.0, 98.0])

    result = fit_dose_response(x, y)

    assert not any("increasing trend" in w for w in result.warnings)


def test_all_identical_responses_does_not_crash():
    x = np.array(DEFAULT_CONCENTRATIONS_NM)
    y = np.full(x.shape, 42.0)

    result = fit_dose_response(x, y)

    assert isinstance(result.converged, bool)


def test_fewer_data_points_than_parameters_does_not_crash():
    x = np.array([0.0, 100.0, 10000.0])
    y = np.array([5.0, 50.0, 95.0])

    result = fit_dose_response(x, y)

    assert result.converged is False
    assert any("not enough data" in w for w in result.warnings)


def test_mismatched_lengths_raises():
    with pytest.raises(ValueError):
        fit_dose_response([1.0, 2.0], [1.0])


def test_sparse_gradient_flags_wide_ec50_confidence_interval():
    x, y = simulate_dose_response(
        [0.0, 10000.0],
        **TRUE_PARAMS,
        noise_sd=1.0,
        n_replicates=3,
        seed=3,
    )

    result = fit_dose_response(x, y)

    assert result.converged
    assert any("EC50 95% CI" in w or "distinct concentration" in w for w in result.warnings)
