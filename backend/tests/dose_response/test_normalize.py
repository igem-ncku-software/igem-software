import numpy as np
import pandas as pd
import pytest

from app.dose_response.normalize import blank_subtract, normalize_fluorescence


def _synthetic_tidy() -> pd.DataFrame:
    return pd.DataFrame(
        [
            # time_h=0: blank mean RFU=10, OD=0.05
            {"well": "G1", "role": "blank", "time_h": 0.0, "RFU": 10.0, "OD600": 0.05},
            {"well": "G2", "role": "blank", "time_h": 0.0, "RFU": 12.0, "OD600": 0.05},
            {"well": "G3", "role": "blank", "time_h": 0.0, "RFU": 8.0, "OD600": 0.05},
            {"well": "A1", "role": "sample", "time_h": 0.0, "RFU": 110.0, "OD600": 0.25},  # OD_corr=0.20 -> valid
            {"well": "A2", "role": "sample", "time_h": 0.0, "RFU": 15.0, "OD600": 0.06},  # OD_corr=0.01 -> gated
            {"well": "A3", "role": "sample", "time_h": 0.0, "RFU": 9.0, "OD600": 0.03},  # OD_corr=-0.02 -> gated
            {"well": "A4", "role": "sample", "time_h": 0.0, "RFU": 30.0, "OD600": 0.071},  # OD_corr=0.021 -> just above od_min, valid
            {"well": "A5", "role": "sample", "time_h": 0.0, "RFU": 30.0, "OD600": 0.069},  # OD_corr=0.019 -> just below od_min, gated
            # time_h=1: blank mean RFU=20, OD=0.05
            {"well": "G1", "role": "blank", "time_h": 1.0, "RFU": 20.0, "OD600": 0.05},
            {"well": "G2", "role": "blank", "time_h": 1.0, "RFU": 22.0, "OD600": 0.06},
            {"well": "G3", "role": "blank", "time_h": 1.0, "RFU": 18.0, "OD600": 0.04},
            {"well": "A1", "role": "sample", "time_h": 1.0, "RFU": 220.0, "OD600": 0.30},  # OD_corr=0.25 -> valid
        ]
    )


# --- blank_subtract() ---


def test_blank_subtract_uses_same_time_point_blank_mean():
    result = blank_subtract(_synthetic_tidy())
    a1_t0 = result[(result.well == "A1") & (result.time_h == 0.0)].iloc[0]
    a1_t1 = result[(result.well == "A1") & (result.time_h == 1.0)].iloc[0]

    assert a1_t0["RFU_corr"] == pytest.approx(100.0)  # 110 - mean(10,12,8)=10
    assert a1_t0["OD_corr"] == pytest.approx(0.20)  # 0.25 - 0.05
    assert a1_t1["RFU_corr"] == pytest.approx(200.0)  # 220 - mean(20,22,18)=20
    assert a1_t1["OD_corr"] == pytest.approx(0.25)  # 0.30 - 0.05


def test_blank_subtract_handles_negative_od_corr_without_error():
    result = blank_subtract(_synthetic_tidy())
    a3 = result[(result.well == "A3") & (result.time_h == 0.0)].iloc[0]
    assert a3["OD_corr"] == pytest.approx(-0.02)


def test_blank_subtract_output_columns():
    result = blank_subtract(_synthetic_tidy())
    assert "RFU_corr" in result.columns
    assert "OD_corr" in result.columns
    assert "RFU_blank" not in result.columns
    assert "OD_blank" not in result.columns


# --- normalize_fluorescence(): F computation + OD gating ---


def test_normalize_computes_f_for_valid_wells():
    result = normalize_fluorescence(blank_subtract(_synthetic_tidy()))
    a1_t0 = result[(result.well == "A1") & (result.time_h == 0.0)].iloc[0]
    a1_t1 = result[(result.well == "A1") & (result.time_h == 1.0)].iloc[0]

    assert a1_t0["F"] == pytest.approx(500.0)  # 100 / 0.20
    assert a1_t1["F"] == pytest.approx(800.0)  # 200 / 0.25


def test_normalize_gates_small_positive_od_corr_to_nan():
    result = normalize_fluorescence(blank_subtract(_synthetic_tidy()))
    a2 = result[(result.well == "A2") & (result.time_h == 0.0)].iloc[0]
    assert np.isnan(a2["F"])


def test_normalize_gates_negative_od_corr_to_nan():
    result = normalize_fluorescence(blank_subtract(_synthetic_tidy()))
    a3 = result[(result.well == "A3") & (result.time_h == 0.0)].iloc[0]
    assert np.isnan(a3["F"])


def test_normalize_od_corr_just_above_threshold_is_valid():
    """Deliberately not testing OD_corr == od_min exactly: 0.07 - 0.05 lands on
    0.019999999999999997 in float64, one ULP below the 0.02 literal, which
    would gate a mathematically-boundary well - a floating-point-comparison
    trap, not a real od_min-off-by-one. Test comfortably on each side instead.
    """
    result = normalize_fluorescence(blank_subtract(_synthetic_tidy()), od_min=0.02)
    a4 = result[(result.well == "A4") & (result.time_h == 0.0)].iloc[0]

    assert a4["OD_corr"] == pytest.approx(0.021)
    assert a4["F"] == pytest.approx(20 / 0.021)


def test_normalize_od_corr_just_below_threshold_is_gated():
    result = normalize_fluorescence(blank_subtract(_synthetic_tidy()), od_min=0.02)
    a5 = result[(result.well == "A5") & (result.time_h == 0.0)].iloc[0]

    assert a5["OD_corr"] == pytest.approx(0.019)
    assert np.isnan(a5["F"])


def test_normalize_custom_od_min_gates_differently():
    result = normalize_fluorescence(blank_subtract(_synthetic_tidy()), od_min=0.5)
    a1_t0 = result[(result.well == "A1") & (result.time_h == 0.0)].iloc[0]
    assert np.isnan(a1_t0["F"])  # OD_corr=0.20 < od_min=0.5 now


def test_normalize_blank_wells_self_gate():
    result = normalize_fluorescence(blank_subtract(_synthetic_tidy()))
    blanks_t0 = result[(result.role == "blank") & (result.time_h == 0.0)]
    assert blanks_t0["F"].isna().all()
