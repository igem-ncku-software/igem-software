"""Reader-export parsing and tidy-table assembly (spec docs/dose_response_model_spec.md §4).

Adapter pattern (§4.2): load_reader_export() is the only function that knows
the SpectraMax ASCII export's line-by-line syntax. Everything downstream
(to_tidy() and later modules) works on well/time_h/RFU/OD600 rows, so a
future second instrument only needs its own load_*_export() parser.
"""

import re
from pathlib import Path

import numpy as np
import pandas as pd

_TIME_RE = re.compile(r"^Time\s+(\d+):(\d+):(\d+)")
_ROW_LETTERS = {"A", "B", "C", "D", "E", "F", "G", "H"}

# The file's own block labels ("Plate:\t<label>\t...") don't match the tidy
# schema's column names (§4.1), so map them explicitly.
_PLATE_LABEL_TO_MEASUREMENT = {
    "GFP_fluorescence": "RFU",
    "OD600": "OD600",
}

# Design v.1 plate map (§1): row -> AHL concentration, column -> strain.
_ROW_CONCENTRATIONS_M = {
    "A": 0.0,
    "B": 1e-9,
    "C": 1e-8,
    "D": 1e-7,
    "E": 1e-6,
    "F": 1e-5,
}
_STRAIN_COLUMNS = {
    "TOP10": (1, 2, 3),
    "DH5α": (4, 5, 6),
    "BL21": (7, 8, 9),
}
_BLANK_ROW = "G"
_POSITIVE_WELLS = ("H1", "H2", "H3")


def load_reader_export(path: str | Path) -> pd.DataFrame:
    """Parse one SpectraMax M2/M2e ASCII export (§4.2).

    Format: 1+ "Plate:" blocks (one per measurement type), each a series of
    "Time HH:MM:SS" 8x12 matrices (row letter x column number), terminated by
    "~End". Empty cells (unused wells, e.g. columns 10-12 in the design v.1
    layout) are dropped rather than turned into NaN rows.

    Returns one row per populated well x time_h, columns: well, time_h, and
    one column per measurement type found in the file (e.g. RFU, OD600).
    """
    lines = Path(path).read_text(encoding="utf-8").splitlines()

    long_rows: list[tuple[str, float, str, float]] = []
    measurement: str | None = None
    time_h: float | None = None

    for line in lines:
        stripped = line.strip()

        if stripped.startswith("Plate:"):
            fields = line.split("\t")
            label = fields[1].strip() if len(fields) > 1 else ""
            measurement = _PLATE_LABEL_TO_MEASUREMENT.get(label, label)
            continue

        if stripped == "~End":
            measurement = None
            time_h = None
            continue

        time_match = _TIME_RE.match(stripped)
        if time_match:
            hh, mm, ss = (int(group) for group in time_match.groups())
            time_h = hh + mm / 60 + ss / 3600
            continue

        if not stripped or measurement is None or time_h is None:
            continue

        cells = line.split("\t")
        row_letter = cells[0].strip()
        if row_letter not in _ROW_LETTERS:
            continue  # not a data row (e.g. the "\t1\t2\t...\t12" column header)

        for col_idx, raw_value in enumerate(cells[1:13], start=1):
            raw_value = raw_value.strip()
            if not raw_value:
                continue
            well = f"{row_letter}{col_idx}"
            long_rows.append((well, time_h, measurement, float(raw_value)))

    long_df = pd.DataFrame(long_rows, columns=["well", "time_h", "measurement", "value"])
    wide = long_df.pivot(index=["well", "time_h"], columns="measurement", values="value")
    wide = wide.reset_index()
    wide.columns.name = None
    return wide


def load_plate_map() -> dict[str, dict]:
    """Design v.1 plate map (§1), expanded to a per-well lookup table.

    TODO(§7): hardcoded here for now. Once config/experiment.yaml + pyyaml
    loading exist, this should read the same shape from that file instead,
    so plate layouts can change without editing code (per §1's own note:
    "Plate map 不要寫死在程式裡，放進 config").
    """
    col_to_strain = {col: strain for strain, cols in _STRAIN_COLUMNS.items() for col in cols}
    plate_map: dict[str, dict] = {}

    for row_letter, concentration_M in _ROW_CONCENTRATIONS_M.items():
        for col, strain in col_to_strain.items():
            well = f"{row_letter}{col}"
            plate_map[well] = {
                "strain": strain,
                "concentration_M": concentration_M,
                "replicate": _STRAIN_COLUMNS[strain].index(col) + 1,
                "role": "sample",
            }

    for col, strain in col_to_strain.items():
        well = f"{_BLANK_ROW}{col}"
        plate_map[well] = {
            "strain": strain,
            "concentration_M": np.nan,
            "replicate": _STRAIN_COLUMNS[strain].index(col) + 1,
            "role": "blank",
        }

    for replicate, well in enumerate(_POSITIVE_WELLS, start=1):
        plate_map[well] = {
            "strain": None,
            "concentration_M": np.nan,
            "replicate": replicate,
            "role": "positive",
        }

    return plate_map


def to_tidy(raw: pd.DataFrame, plate_map: dict[str, dict]) -> pd.DataFrame:
    """Attach plate-map metadata to parsed reader data to build the §4.1 tidy table.

    raw: output of load_reader_export() - one row per well x time_h.
    plate_map: well -> {strain, concentration_M, replicate, role}, e.g. from
    load_plate_map(). Wells present in raw but absent from plate_map (not
    part of the experimental design) are dropped.
    """
    records = []
    for row in raw.itertuples(index=False):
        meta = plate_map.get(row.well)
        if meta is None:
            continue
        records.append(
            {
                "strain": meta["strain"],
                "concentration_M": meta["concentration_M"],
                "replicate": meta["replicate"],
                "time_h": row.time_h,
                "RFU": getattr(row, "RFU", np.nan),
                "OD600": getattr(row, "OD600", np.nan),
                "well": row.well,
                "role": meta["role"],
            }
        )

    columns = ["strain", "concentration_M", "replicate", "time_h", "RFU", "OD600", "well", "role"]
    return pd.DataFrame.from_records(records, columns=columns)
