from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

FIXTURE = Path(__file__).parent / "fixtures" / "simulated_spectramax_export.txt"

client = TestClient(app)

TRUE_EC50_NM = {"TOP10": 100.0, "DH5α": 300.0, "BL21": 50.0}


# --- POST /analyze ---


def test_analyze_returns_all_three_strains_with_correct_ec50s():
    with open(FIXTURE, "rb") as f:
        response = client.post(
            "/api/dose_response/analyze",
            files={"file": ("simulated_spectramax_export.txt", f, "text/plain")},
        )

    assert response.status_code == 200
    strains = response.json()["strains"]
    assert set(strains) == set(TRUE_EC50_NM)

    for strain, true_ec50 in TRUE_EC50_NM.items():
        result = strains[strain]
        assert result["responsive"] is True
        assert result["ec50_nM"] == pytest.approx(true_ec50, rel=0.20)


def test_analyze_includes_chart_data_for_plotting():
    with open(FIXTURE, "rb") as f:
        response = client.post(
            "/api/dose_response/analyze",
            files={"file": ("simulated_spectramax_export.txt", f, "text/plain")},
        )

    top10 = response.json()["strains"]["TOP10"]

    # 6 tested concentrations (0, 1nM..10uM), all present incl. the excluded-from-fit 0 point.
    assert len(top10["plateau_points"]) == 6
    assert any(conc_nM == 0.0 for conc_nM, _ in top10["plateau_points"])

    assert top10["fit_curve"] is not None
    assert len(top10["fit_curve"]) == 50
    curve_concs = [conc for conc, _ in top10["fit_curve"]]
    assert curve_concs == sorted(curve_concs)  # ascending, ready to plot as a line


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
