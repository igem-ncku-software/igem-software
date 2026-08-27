import numpy as np
import pytest

from app.dose_response.model import four_pl


TOP, BOTTOM, EC50, HILL = 100.0, 5.0, 50.0, 1.5


def test_at_ec50_response_is_midpoint():
    assert four_pl(EC50, TOP, BOTTOM, EC50, HILL) == pytest.approx((TOP + BOTTOM) / 2)


def test_at_zero_converges_to_bottom():
    assert four_pl(0.0, TOP, BOTTOM, EC50, HILL) == pytest.approx(BOTTOM)


def test_negative_hill_slope_still_converges_to_bottom_at_zero():
    assert four_pl(0.0, TOP, BOTTOM, EC50, hill_slope=-1.5) == pytest.approx(BOTTOM)


def test_large_x_converges_to_top():
    assert four_pl(1e9, TOP, BOTTOM, EC50, HILL) == pytest.approx(TOP, rel=1e-3)


def test_accepts_array_input():
    x = np.array([0.0, EC50, 1e9])
    result = four_pl(x, TOP, BOTTOM, EC50, HILL)

    assert isinstance(result, np.ndarray)
    assert result[0] == pytest.approx(BOTTOM)
    assert result[1] == pytest.approx((TOP + BOTTOM) / 2)
    assert result[2] == pytest.approx(TOP, rel=1e-3)


def test_monotonically_increasing_for_positive_hill_slope():
    x = np.array([0.0, 1.0, 10.0, 50.0, 100.0, 1000.0, 1e6])
    result = four_pl(x, TOP, BOTTOM, EC50, HILL)

    assert np.all(np.diff(result) > 0)
