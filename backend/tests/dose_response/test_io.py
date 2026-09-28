import numpy as np
import pandas as pd
import pytest

from app.dose_response.io import load_plate_map, to_tidy


# --- load_plate_map(): design v.1 layout ---


def test_plate_map_sample_well():
    plate_map = load_plate_map()
    assert plate_map["A1"] == {
        "strain": "TOP10",
        "concentration_M": 0.0,
        "replicate": 1,
        "role": "sample",
    }
    # D = 100 nM = 1e-7 M row; column 4 is DH5α's first replicate.
    assert plate_map["D4"] == {
        "strain": "DH5α",
        "concentration_M": 1e-7,
        "replicate": 1,
        "role": "sample",
    }
    # Column 9 is BL21's third replicate.
    assert plate_map["F9"] == {
        "strain": "BL21",
        "concentration_M": 1e-5,
        "replicate": 3,
        "role": "sample",
    }


def test_plate_map_blank_row_keeps_strain_grouping_but_no_concentration():
    plate_map = load_plate_map()
    blank = plate_map["G7"]

    assert blank["role"] == "blank"
    assert blank["strain"] == "BL21"  # column 7 pairs with BL21's columns
    assert blank["replicate"] == 1
    assert np.isnan(blank["concentration_M"])


def test_plate_map_positive_wells_have_no_strain_or_concentration():
    plate_map = load_plate_map()

    for i, well in enumerate(["H1", "H2", "H3"], start=1):
        entry = plate_map[well]
        assert entry["role"] == "positive"
        assert entry["strain"] is None
        assert entry["replicate"] == i
        assert np.isnan(entry["concentration_M"])


def test_plate_map_has_exactly_the_66_designed_wells():
    plate_map = load_plate_map()
    assert len(plate_map) == 66
    assert "A10" not in plate_map
    assert "H4" not in plate_map


# --- to_tidy(): attaches plate-map metadata to parsed reader rows ---


def test_to_tidy_column_order_matches_the_tidy_schema():
    raw = pd.DataFrame({"well": ["A1"], "time_h": [0.0], "RFU": [100.0], "OD600": [0.1]})
    tidy = to_tidy(raw, load_plate_map())

    assert list(tidy.columns) == [
        "strain",
        "concentration_M",
        "replicate",
        "time_h",
        "RFU",
        "OD600",
        "well",
        "role",
    ]


def test_to_tidy_attaches_correct_metadata_per_well():
    raw = pd.DataFrame(
        {
            "well": ["A1", "D4", "G1", "H2"],
            "time_h": [0.0, 3.0, 0.0, 1.0],
            "RFU": [100.0, 403.582, 30.0, 50.0],
            "OD600": [0.1, 0.5, 0.04, 0.2],
        }
    )
    tidy = to_tidy(raw, load_plate_map()).set_index("well")

    assert tidy.loc["A1", "strain"] == "TOP10"
    assert tidy.loc["A1", "role"] == "sample"
    assert tidy.loc["D4", "concentration_M"] == pytest.approx(1e-7)
    assert tidy.loc["D4", "RFU"] == pytest.approx(403.582)
    assert tidy.loc["G1", "role"] == "blank"
    # pandas' default string dtype represents a missing str as NaN, not None.
    assert pd.isna(tidy.loc["H2", "strain"])
    assert tidy.loc["H2", "role"] == "positive"


def test_to_tidy_drops_wells_absent_from_plate_map():
    raw = pd.DataFrame({"well": ["A1", "Z9"], "time_h": [0.0, 0.0], "RFU": [1.0, 2.0], "OD600": [0.1, 0.2]})
    tidy = to_tidy(raw, load_plate_map())

    assert list(tidy["well"]) == ["A1"]


def test_to_tidy_fills_missing_measurement_column_with_nan():
    """A future single-measurement export (e.g. OD600 only) shouldn't crash to_tidy()."""
    raw = pd.DataFrame({"well": ["A1"], "time_h": [0.0], "OD600": [0.1]})
    tidy = to_tidy(raw, load_plate_map())

    assert np.isnan(tidy.loc[0, "RFU"])
    assert tidy.loc[0, "OD600"] == pytest.approx(0.1)

