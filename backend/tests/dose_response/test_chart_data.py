import json

import numpy as np
import pytest

from app.dose_response.chart_data import to_chart_data
from app.dose_response.fitting import fit_dose_response
from app.dose_response.simulate import DEFAULT_CONCENTRATIONS_NM, simulate_dose_response


TRUE_PARAMS = dict(top=100.0, bottom=5.0, ec50=50.0, hill_slope=1.5)


@pytest.fixture
def fit_and_data():
    x, y = simulate_dose_response(
        DEFAULT_CONCENTRATIONS_NM, **TRUE_PARAMS, noise_sd=0.5, n_replicates=4, seed=0
    )
    return x, y, fit_dose_response(x, y)


def test_scatter_contains_every_raw_point(fit_and_data):
    x, y, result = fit_and_data
    chart = to_chart_data(x, y, result)

    assert len(chart["scatter"]) == len(x)
    assert chart["scatter"][0] == {"x": float(x[0]), "y": float(y[0])}


def test_curve_includes_zero_and_is_log_spaced_otherwise(fit_and_data):
    x, y, result = fit_and_data
    chart = to_chart_data(x, y, result, n_curve_points=50)

    assert chart["curve"][0]["x"] == 0.0
    assert len(chart["curve"]) == 1 + 50

    positive_curve_x = [point["x"] for point in chart["curve"][1:]]
    assert positive_curve_x == sorted(positive_curve_x)
    assert min(positive_curve_x) == pytest.approx(1.0)
    assert max(positive_curve_x) == pytest.approx(10_000.0)


def test_curve_y_matches_predict(fit_and_data):
    x, y, result = fit_and_data
    chart = to_chart_data(x, y, result)

    for point in chart["curve"]:
        assert point["y"] == pytest.approx(float(result.predict(point["x"])))


def test_metadata_passthrough(fit_and_data):
    x, y, result = fit_and_data
    chart = to_chart_data(x, y, result)

    assert chart["ec50"] == result.params["ec50"]
    assert chart["params"] == result.params
    assert chart["r_squared"] == result.r_squared
    assert chart["converged"] == result.converged
    assert chart["warnings"] == result.warnings


def test_output_is_json_serializable(fit_and_data):
    x, y, result = fit_and_data
    chart = to_chart_data(x, y, result)

    json.dumps(chart)  # should not raise


def test_all_zero_concentrations_only_returns_zero_point():
    x = np.array([0.0, 0.0, 0.0])
    y = np.array([5.0, 6.0, 4.0])
    result = fit_dose_response(x, y)

    chart = to_chart_data(x, y, result)

    assert chart["curve"] == [{"x": 0.0, "y": pytest.approx(float(result.predict(0.0)))}]
