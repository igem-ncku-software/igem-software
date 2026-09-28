import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


# --- POST /analyze ---


def test_analyze_rejects_a_file_with_no_recognizable_wells():
    response = client.post(
        "/api/dose_response/analyze",
        files={"file": ("garbage.txt", b"this is not a SpectraMax export\n", "text/plain")},
    )
    assert response.status_code == 400


# --- POST /predict ---

BOTTOM, TOP, EC50_NM, N = 200.0, 8000.0, 100.0, 1.5


def _hill_nM(conc_nM, bottom=BOTTOM, top=TOP, ec50_nM=EC50_NM, n=N):
    ratio = (conc_nM / ec50_nM) ** n
    return bottom + (top - bottom) * ratio / (1 + ratio)


def test_predict_recovers_a_known_concentration():
    F = _hill_nM(EC50_NM)  # F at EC50 itself -> should invert back to exactly EC50

    response = client.post(
        "/api/dose_response/predict",
        json={
            "strain": "TOP10",
            "fluorescence": F,
            "hill_params": {"bottom": BOTTOM, "top": TOP, "ec50_nM": EC50_NM, "n": N},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["in_range"] is True
    assert body["concentration_nM"] == pytest.approx(EC50_NM, rel=1e-4)


def test_predict_reports_out_of_range_without_nan_or_error():
    response = client.post(
        "/api/dose_response/predict",
        json={
            "strain": "TOP10",
            "fluorescence": BOTTOM - 10,
            "hill_params": {"bottom": BOTTOM, "top": TOP, "ec50_nM": EC50_NM, "n": N},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["in_range"] is False
    assert body["concentration_nM"] is None
    assert body["message"] is not None


def test_predict_propagates_ec50_ci():
    F = _hill_nM(EC50_NM * 2)

    response = client.post(
        "/api/dose_response/predict",
        json={
            "strain": "TOP10",
            "fluorescence": F,
            "hill_params": {
                "bottom": BOTTOM,
                "top": TOP,
                "ec50_nM": EC50_NM,
                "n": N,
                "ec50_nM_ci95": [EC50_NM * 0.8, EC50_NM * 1.2],
            },
        },
    )

    body = response.json()
    assert body["concentration_nM_ci95"] is not None
    lo, hi = body["concentration_nM_ci95"]
    assert lo < body["concentration_nM"] < hi
