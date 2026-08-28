"""Blank subtraction and OD-gated fluorescence normalization (spec §5.1).

Takes the io.py tidy table (well/time_h/RFU/OD600/role/...) and adds the
per-well, per-time-point corrected values and normalized fluorescence F.
"""

import numpy as np
import pandas as pd

OD_MIN_DEFAULT = 0.02


def blank_subtract(tidy: pd.DataFrame) -> pd.DataFrame:
    """OD_corr = OD600 - OD_blank(t); RFU_corr = RFU - RFU_blank(t) (spec §5.1).

    OD_blank(t)/RFU_blank(t) are the mean OD600/RFU across role=="blank"
    wells at the same time_h. Which wells count as blank comes from the
    tidy table's own `role` column (set by io.py's plate map), not a
    hardcoded row letter, so a future plate layout with a different blank
    row needs no change here.
    """
    blank_means = (
        tidy.loc[tidy["role"] == "blank", ["time_h", "RFU", "OD600"]]
        .groupby("time_h")
        .mean()
        .rename(columns={"RFU": "RFU_blank", "OD600": "OD_blank"})
        .reset_index()
    )

    result = tidy.merge(blank_means, on="time_h", how="left")
    result["RFU_corr"] = result["RFU"] - result["RFU_blank"]
    result["OD_corr"] = result["OD600"] - result["OD_blank"]
    return result.drop(columns=["RFU_blank", "OD_blank"])


def normalize_fluorescence(blank_subtracted: pd.DataFrame, od_min: float = OD_MIN_DEFAULT) -> pd.DataFrame:
    """F = RFU_corr / OD_corr, gated to NaN where OD_corr < od_min (spec §5.1).

    Expects blank_subtracted to already have RFU_corr/OD_corr columns, i.e.
    this is normally called on blank_subtract()'s output.

    F is left negative when RFU_corr < 0 (background > signal) - this is
    EXPECTED at early/low-signal timepoints, not a bug, and is deliberately
    NOT clamped to 0 here. Clamping would bias the mean upward for exactly
    the low-signal groups (e.g. the 0 nM control) that §5.4 flatness_test()
    and §5.5 LOD rely on for an unbiased baseline - the OD_corr<od_min gate
    below is the only "unreliable measurement" filter spec §5.1 calls for.
    A non-negative *display* should be done by clamping the plot axis at
    the plotting layer (§6), never by changing this data.

    TODO(§7): od_min should eventually come from experiment.yaml
    (thresholds.od_min), same as load_plate_map()'s TODO in io.py -
    hardcoded to the spec's suggested default (0.02) for now.
    """
    result = blank_subtracted.copy()
    valid = result["OD_corr"] >= od_min

    F = pd.Series(np.nan, index=result.index, dtype=float)
    F[valid] = result.loc[valid, "RFU_corr"] / result.loc[valid, "OD_corr"]
    result["F"] = F

    return result
