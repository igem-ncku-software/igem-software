import numpy as np
import pytest
from scipy.optimize import curve_fit

from app.dose_response.models import hill, logistic_time


# --- hill(): boundary conditions (spec §9 item 3) ---

BOTTOM, TOP, EC50, N = 200.0, 8000.0, 1e-7, 1.5


def test_hill_at_zero_converges_to_bottom():
    assert hill(0.0, BOTTOM, TOP, EC50, N) == pytest.approx(BOTTOM)


def test_hill_at_large_concentration_converges_to_top():
    assert hill(1e6 * EC50, BOTTOM, TOP, EC50, N) == pytest.approx(TOP, rel=1e-3)


def test_hill_at_ec50_is_midpoint():
    assert hill(EC50, BOTTOM, TOP, EC50, N) == pytest.approx((TOP + BOTTOM) / 2)


def test_hill_accepts_array_input_and_is_monotonic_increasing():
    A = np.array([0.0, EC50 / 100, EC50, EC50 * 100, 1e6 * EC50])
    result = hill(A, BOTTOM, TOP, EC50, N)

    assert isinstance(result, np.ndarray)
    assert np.all(np.diff(result) > 0)


# --- hill(): recover known EC50/n from noisy synthetic data (spec §9 item 1) ---


def test_fit_recovers_known_ec50_and_hill_slope():
    """doseresponse.py's fit_hill() doesn't exist yet (spec §10 builds that in a
    later step) - this fits scipy.optimize.curve_fit directly against hill() to
    confirm the pure function's shape is correct and recoverable by NLS.

    TODO(§10 item 4): once app/dose_response/doseresponse.py has fit_hill(),
    add a test that calls fit_hill() itself - passing here doesn't prove
    fit_hill() converges/recovers correctly. Replace this test or keep it
    alongside the new one.
    """
    rng = np.random.default_rng(0)
    true_bottom, true_top, true_ec50, true_n = 200.0, 8000.0, 1e-7, 1.5
    concentrations = np.array([1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4])

    noise_sd = 0.02 * (true_top - true_bottom)
    responses = hill(concentrations, true_bottom, true_top, true_ec50, true_n)
    responses = responses + rng.normal(0, noise_sd, concentrations.shape)

    popt, _ = curve_fit(
        hill,
        concentrations,
        responses,
        p0=[100.0, 5000.0, 5e-7, 1.0],
        bounds=([0, 0, 0, 0.5], [np.inf, np.inf, np.inf, 4.0]),
        maxfev=10_000,
    )
    _, _, fitted_ec50, fitted_n = popt

    assert fitted_ec50 == pytest.approx(true_ec50, rel=0.20)
    assert fitted_n == pytest.approx(true_n, abs=0.3)


# TODO(§10 item 4): spec §9 item 2 - generate a flat synthetic curve
# (top ~= bottom) and assert flatness_test() returns responsive=False.
# Not covered here: flatness_test() lives in doseresponse.py, which doesn't
# exist yet.


# --- logistic_time(): boundary conditions, same spirit as hill()'s (not spelled
# out in spec §9, which only lists hill()/fit_hill()/flatness_test cases) ---

F0, FMAX, R, T0 = 500.0, 5000.0, 1.5, 4.0


def test_logistic_time_at_t0_is_midpoint():
    assert logistic_time(T0, F0, FMAX, R, T0) == pytest.approx((F0 + FMAX) / 2)


def test_logistic_time_long_before_t0_converges_to_f0():
    assert logistic_time(T0 - 50 / R, F0, FMAX, R, T0) == pytest.approx(F0, abs=1e-6)


def test_logistic_time_long_after_t0_converges_to_fmax():
    assert logistic_time(T0 + 50 / R, F0, FMAX, R, T0) == pytest.approx(FMAX, abs=1e-6)


def test_logistic_time_accepts_array_input_and_is_monotonic_increasing():
    t = np.linspace(0, 8, 50)
    result = logistic_time(t, F0, FMAX, R, T0)

    assert isinstance(result, np.ndarray)
    assert np.all(np.diff(result) > 0)
