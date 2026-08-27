import math

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.dose_response.simulate import DEFAULT_CONCENTRATIONS_NM, simulate_dose_response

client = TestClient(app)

TRUE_PARAMS = dict(top=100.0, bottom=5.0, ec50=50.0, hill_slope=1.5)


def test_fit_endpoint_returns_params_and_chart_data():
    x, y = simulate_dose_response(
        DEFAULT_CONCENTRATIONS_NM, **TRUE_PARAMS, noise_sd=0.5, n_replicates=4, seed=0
    )

    response = client.post(
        "/api/dose_response/fit",
        json={"concentrations": list(x), "responses": list(y)},
    )

    assert response.status_code == 200
    body = response.json()

    assert body["converged"] is True
    assert body["params"]["ec50"] == pytest.approx(TRUE_PARAMS["ec50"], rel=0.1)
    assert "scatter" in body["chart_data"]
    assert "curve" in body["chart_data"]


def test_fit_endpoint_rejects_empty_data():
    response = client.post(
        "/api/dose_response/fit", json={"concentrations": [], "responses": []}
    )
    assert response.status_code == 400


def test_fit_endpoint_rejects_mismatched_lengths():
    response = client.post(
        "/api/dose_response/fit",
        json={"concentrations": [1.0, 2.0], "responses": [1.0]},
    )
    assert response.status_code == 400


def test_fit_endpoint_underdetermined_fit_returns_valid_json_not_nan():
    response = client.post(
        "/api/dose_response/fit",
        json={"concentrations": [0.0, 100.0, 10000.0], "responses": [5.0, 50.0, 95.0]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["converged"] is False
    assert body["r_squared"] is None
    assert body["param_stderr"] is None


def test_fit_endpoint_with_fix_bottom():
    x, y = simulate_dose_response(
        DEFAULT_CONCENTRATIONS_NM, **TRUE_PARAMS, noise_sd=0.5, n_replicates=4, seed=1
    )

    response = client.post(
        "/api/dose_response/fit",
        json={"concentrations": list(x), "responses": list(y), "fix_bottom": 5.0},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["params"]["bottom"] == 5.0


def test_simulate_endpoint_returns_requested_length():
    response = client.post(
        "/api/dose_response/simulate",
        json={**TRUE_PARAMS, "noise_sd": 1.0, "n_replicates": 3, "seed": 42},
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body["concentrations"]) == len(DEFAULT_CONCENTRATIONS_NM) * 3
    assert len(body["responses"]) == len(body["concentrations"])


def test_simulate_endpoint_rejects_invalid_replicates():
    response = client.post(
        "/api/dose_response/simulate",
        json={**TRUE_PARAMS, "n_replicates": 0},
    )
    assert response.status_code == 400


def test_root_lists_dose_response_endpoints():
    response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert body["dose_response_fit"] == "POST /api/dose_response/fit"
