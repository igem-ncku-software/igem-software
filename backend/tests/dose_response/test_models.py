import numpy as np
import pytest

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


# Spec §9 items 1 and 2 (fit_hill() EC50 recovery; flatness_test() on a flat
# curve) now live in test_doseresponse.py, calling the real fit_hill()/
# flatness_test() from doseresponse.py - this file's earlier scipy.curve_fit
# stand-in for item 1 has been replaced, not kept alongside.


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
